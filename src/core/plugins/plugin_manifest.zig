const std = @import("std");
const io_mod = @import("../shared/io.zig");
const sort_utils = @import("../shared/sort_utils.zig");

const Allocator = std.mem.Allocator;

pub const schema_v1 = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
pub const max_manifest_bytes: usize = 64 * 1024;

pub const Manifest = struct {
    name: []u8,
    version: ?[]u8 = null,
    description: ?[]u8 = null,
    unknown_fields: [][]u8 = &.{},
    extensions_ignored: bool = false,

    pub fn deinit(self: *Manifest, alloc: Allocator) void {
        alloc.free(self.name);
        if (self.version) |value| alloc.free(value);
        if (self.description) |value| alloc.free(value);
        for (self.unknown_fields) |field| alloc.free(field);
        if (self.unknown_fields.len > 0) alloc.free(self.unknown_fields);
        self.* = undefined;
    }
};

pub const Inspection = struct {
    manifest: Manifest,
    skills: [][]u8 = &.{},

    pub fn deinit(self: *Inspection, alloc: Allocator) void {
        self.manifest.deinit(alloc);
        for (self.skills) |name| alloc.free(name);
        if (self.skills.len > 0) alloc.free(self.skills);
        self.* = undefined;
    }
};

pub const ParseError = Allocator.Error || error{
    InvalidJson,
    InvalidManifest,
    InvalidSchema,
    UnsupportedSchema,
    InvalidName,
    InvalidMetadata,
    ManifestTooLarge,
};

pub fn parse(alloc: Allocator, bytes: []const u8) ParseError!Manifest {
    if (bytes.len > max_manifest_bytes) return error.ManifestTooLarge;
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, bytes, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidJson,
    };
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidManifest;
    const object = parsed.value.object;

    const schema_value = object.get("$schema") orelse return error.InvalidSchema;
    if (schema_value != .string or schema_value.string.len == 0) return error.InvalidSchema;
    if (!std.mem.eql(u8, schema_value.string, schema_v1)) return error.UnsupportedSchema;

    const name_value = object.get("name") orelse return error.InvalidName;
    if (name_value != .string or !validPluginName(name_value.string)) return error.InvalidName;

    try validateOptionalString(object, "version");
    try validateOptionalString(object, "description");
    try validateOptionalString(object, "homepage");
    try validateOptionalString(object, "repository");
    try validateOptionalString(object, "license");
    try validateAuthor(object);
    try validateKeywords(object);

    const extensions_ignored = if (object.get("extensions")) |extensions|
        extensions != .object
    else
        false;

    var unknown: std.ArrayList([]u8) = .empty;
    errdefer {
        for (unknown.items) |field| alloc.free(field);
        unknown.deinit(alloc);
    }
    var it = object.iterator();
    while (it.next()) |entry| {
        if (knownField(entry.key_ptr.*)) continue;
        const copy = try alloc.dupe(u8, entry.key_ptr.*);
        unknown.append(alloc, copy) catch |err| {
            alloc.free(copy);
            return err;
        };
    }
    sort_utils.sort([]u8, unknown.items, {}, struct {
        fn lessThan(_: void, left: []u8, right: []u8) bool {
            return std.mem.order(u8, left, right) == .lt;
        }
    }.lessThan);

    const name = try alloc.dupe(u8, name_value.string);
    errdefer alloc.free(name);
    const version = try optionalStringDupe(alloc, object, "version");
    errdefer if (version) |value| alloc.free(value);
    const description = try optionalStringDupe(alloc, object, "description");
    errdefer if (description) |value| alloc.free(value);

    return .{
        .name = name,
        .version = version,
        .description = description,
        .unknown_fields = if (unknown.items.len == 0) blk: {
            unknown.deinit(alloc);
            break :blk &.{};
        } else try unknown.toOwnedSlice(alloc),
        .extensions_ignored = extensions_ignored,
    };
}

pub fn inspectDirectory(alloc: Allocator, root_path: []const u8) !Inspection {
    const canonical_root = try io_mod.realpathAlloc(alloc, root_path);
    defer alloc.free(canonical_root);

    var root = try io_mod.openDirAbsoluteNoFollow(canonical_root, .{ .iterate = true });
    defer root.close(io_mod.getIo());

    var manifest_file = try io_mod.openExistingReadOnlyRegularFile(&root, "plugin.json", .no_follow);
    defer manifest_file.close(io_mod.getIo());
    const stat = try manifest_file.stat(io_mod.getIo());
    if (stat.size > max_manifest_bytes) return error.ManifestTooLarge;
    const bytes = try io_mod.readFileToEnd(alloc, &manifest_file, max_manifest_bytes);
    defer alloc.free(bytes);

    var manifest = try parse(alloc, bytes);
    errdefer manifest.deinit(alloc);

    const skills = try discoverSkills(alloc, &root);
    return .{ .manifest = manifest, .skills = skills };
}

fn discoverSkills(alloc: Allocator, root: *std.Io.Dir) ![][]u8 {
    var skills_dir = root.openDir(io_mod.getIo(), "skills", .{
        .iterate = true,
        .follow_symlinks = false,
    }) catch |err| switch (err) {
        error.FileNotFound => return &.{},
        else => return err,
    };
    defer skills_dir.close(io_mod.getIo());

    var names: std.ArrayList([]u8) = .empty;
    errdefer {
        for (names.items) |name| alloc.free(name);
        names.deinit(alloc);
    }

    var it = skills_dir.iterate();
    while (try it.next(io_mod.getIo())) |entry| {
        if (entry.kind != .directory) continue;
        var candidate = skills_dir.openDir(io_mod.getIo(), entry.name, .{
            .follow_symlinks = false,
        }) catch continue;
        defer candidate.close(io_mod.getIo());

        const skill_stat = candidate.statFile(io_mod.getIo(), "SKILL.md", .{
            .follow_symlinks = false,
        }) catch continue;
        if (skill_stat.kind != .file) continue;

        const name = try alloc.dupe(u8, entry.name);
        names.append(alloc, name) catch |err| {
            alloc.free(name);
            return err;
        };
    }

    sort_utils.sort([]u8, names.items, {}, struct {
        fn lessThan(_: void, left: []u8, right: []u8) bool {
            return std.mem.order(u8, left, right) == .lt;
        }
    }.lessThan);
    if (names.items.len == 0) {
        names.deinit(alloc);
        return &.{};
    }
    return names.toOwnedSlice(alloc);
}

fn validateOptionalString(object: std.json.ObjectMap, key: []const u8) ParseError!void {
    const value = object.get(key) orelse return;
    if (value != .string) return error.InvalidMetadata;
}

fn validateAuthor(object: std.json.ObjectMap) ParseError!void {
    const author = object.get("author") orelse return;
    if (author != .object) return error.InvalidMetadata;
    var it = author.object.iterator();
    while (it.next()) |entry| {
        const key = entry.key_ptr.*;
        if (!std.mem.eql(u8, key, "name") and
            !std.mem.eql(u8, key, "email") and
            !std.mem.eql(u8, key, "url"))
        {
            return error.InvalidMetadata;
        }
        if (entry.value_ptr.* != .string) return error.InvalidMetadata;
    }
}

fn validateKeywords(object: std.json.ObjectMap) ParseError!void {
    const keywords = object.get("keywords") orelse return;
    if (keywords != .array) return error.InvalidMetadata;
    for (keywords.array.items) |item| if (item != .string) return error.InvalidMetadata;
}

fn optionalStringDupe(
    alloc: Allocator,
    object: std.json.ObjectMap,
    key: []const u8,
) Allocator.Error!?[]u8 {
    const value = object.get(key) orelse return null;
    return try alloc.dupe(u8, value.string);
}

fn knownField(key: []const u8) bool {
    inline for ([_][]const u8{
        "$schema", "name", "version", "description", "author",
        "homepage", "repository", "license", "keywords", "extensions",
    }) |known| {
        if (std.mem.eql(u8, key, known)) return true;
    }
    return false;
}

pub fn validPluginName(name: []const u8) bool {
    if (name.len == 0 or name.len > 64) return false;
    if (!std.ascii.isAlphanumeric(name[0]) or !std.ascii.isAlphanumeric(name[name.len - 1])) return false;
    var previous: u8 = 0;
    for (name) |byte| {
        const allowed = (byte >= 'a' and byte <= 'z') or
            std.ascii.isDigit(byte) or byte == '-' or byte == '.';
        if (!allowed) return false;
        if ((byte == '-' and previous == '-') or (byte == '.' and previous == '.')) return false;
        previous = byte;
    }
    return true;
}

test "Agent Plugins v1 minimal manifest parses" {
    const alloc = std.testing.allocator;
    var manifest = try parse(
        alloc,
        \\{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"minimal-plugin"}
    );
    defer manifest.deinit(alloc);
    try std.testing.expectEqualStrings("minimal-plugin", manifest.name);
    try std.testing.expectEqual(@as(usize, 0), manifest.unknown_fields.len);
}

test "unknown fields and non-object extensions are reported but non-fatal" {
    const alloc = std.testing.allocator;
    var manifest = try parse(
        alloc,
        \\{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"plugin.a","extensions":"ignored","zzz":1,"aaa":2}
    );
    defer manifest.deinit(alloc);
    try std.testing.expect(manifest.extensions_ignored);
    try std.testing.expectEqual(@as(usize, 2), manifest.unknown_fields.len);
    try std.testing.expectEqualStrings("aaa", manifest.unknown_fields[0]);
    try std.testing.expectEqualStrings("zzz", manifest.unknown_fields[1]);
}

test "manifest validation rejects invalid names and metadata types" {
    const alloc = std.testing.allocator;
    try std.testing.expectError(error.InvalidName, parse(
        alloc,
        \\{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"Bad--Name"}
    ));
    try std.testing.expectError(error.InvalidMetadata, parse(
        alloc,
        \\{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"valid","keywords":["ok",1]}
    ));
    try std.testing.expectError(error.InvalidMetadata, parse(
        alloc,
        \\{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"valid","author":{"name":"n","extra":"no"}}
    ));
}

test "directory inspection discovers only immediate skill directories" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = io_mod.getIo();

    {
        var file = try tmp.dir.createFile(io, "plugin.json", .{ .truncate = true });
        defer file.close(io);
        try file.writeStreamingAll(io,
            "{\"$schema\":\"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json\",\"name\":\"skills-plugin\"}");
    }
    try tmp.dir.createDirPath(io, "skills/zeta");
    try tmp.dir.createDirPath(io, "skills/alpha");
    try tmp.dir.createDirPath(io, "skills/missing");
    try tmp.dir.createDirPath(io, "skills/nested/too-deep");
    {
        var file = try tmp.dir.createFile(io, "skills/zeta/SKILL.md", .{ .truncate = true });
        file.close(io);
    }
    {
        var file = try tmp.dir.createFile(io, "skills/alpha/SKILL.md", .{ .truncate = true });
        file.close(io);
    }
    {
        var file = try tmp.dir.createFile(io, "skills/nested/too-deep/SKILL.md", .{ .truncate = true });
        file.close(io);
    }

    const root = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "");
    defer alloc.free(root);
    var inspected = try inspectDirectory(alloc, root);
    defer inspected.deinit(alloc);

    try std.testing.expectEqualStrings("skills-plugin", inspected.manifest.name);
    try std.testing.expectEqual(@as(usize, 2), inspected.skills.len);
    try std.testing.expectEqualStrings("alpha", inspected.skills[0]);
    try std.testing.expectEqualStrings("zeta", inspected.skills[1]);
}
