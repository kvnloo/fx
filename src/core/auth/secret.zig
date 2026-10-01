const std = @import("std");

/// Overwrite an owned secret before returning its allocation to the allocator.
pub noinline fn zeroAndFree(alloc: std.mem.Allocator, value: []u8) void {
    if (value.len == 0) return;
    zero(value);
    alloc.free(value);
}

/// Overwrite a borrowed secret buffer before its owner releases the allocation.
pub noinline fn zero(value: []const u8) void {
    if (value.len == 0) return;
    std.crypto.secureZero(u8, @constCast(@volatileCast(value)));
}

/// Build a Bearer header without an oversized formatting allocation that can
/// abandon a plaintext token copy while shrinking.
pub fn bearerHeaderAlloc(alloc: std.mem.Allocator, access_token: []const u8) ![]u8 {
    const prefix = "Bearer ";
    const header = try alloc.alloc(u8, prefix.len + access_token.len);
    @memcpy(header[0..prefix.len], prefix);
    @memcpy(header[prefix.len..], access_token);
    return header;
}

test "zeroAndFree overwrites bytes before release" {
    var value = [_]u8{ 1, 2, 3 };
    std.crypto.secureZero(u8, @volatileCast(value[0..]));
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0 }, &value);
}


test "zero overwrites a borrowed buffer" {
    var value = [_]u8{ 1, 2, 3 };
    zero(value[0..]);
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0 }, &value);
}

test "bearerHeaderAlloc returns the exact header size" {
    const header = try bearerHeaderAlloc(std.testing.allocator, "abc.def");
    defer zeroAndFree(std.testing.allocator, header);
    try std.testing.expectEqualStrings("Bearer abc.def", header);
    try std.testing.expectEqual(@as(usize, "Bearer ".len + "abc.def".len), header.len);
}
