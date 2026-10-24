#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, open, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceHeadPattern = /^[0-9a-f]{40}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const usage = 'Usage: node sdk/tern/build-receipt.mjs --build -- [-Dtarget=TARGET] [-Dcpu=CPU] [-Doptimize=MODE] [-jN]';
const generatedDirectories = new Set(['.zig-cache', 'zig-cache', 'zig-out', 'node_modules']);
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function hasGit(root) {
  try { await lstat(join(root, '.git')); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}

async function git(root, args) {
  // An explicit git-dir also handles worktree .git files and does not search a
  // parent repository when an archive has an invalid or missing .git.
  return (await run('git', ['--git-dir=' + join(root, '.git'), '--work-tree=' + root, ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  })).stdout;
}

export async function expectedSourceHead({ root = checkoutRoot, env = process.env } = {}) {
  const supplied = env.FX_TERN_EXPECTED_HEAD;
  if (supplied !== undefined) assert.match(supplied, sourceHeadPattern, 'FX_TERN_EXPECTED_HEAD must contain exactly 40 hexadecimal characters');
  if (!await hasGit(root)) {
    assert.ok(supplied, 'A source archive without .git requires FX_TERN_EXPECTED_HEAD from the exact build source');
    return supplied.toLowerCase();
  }
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  assert.match(head, sourceHeadPattern, 'The checkout Git HEAD must contain exactly 40 hexadecimal characters');
  if (supplied !== undefined) assert.equal(supplied.toLowerCase(), head.toLowerCase(), 'FX_TERN_EXPECTED_HEAD must match the current checkout Git HEAD');
  return head.toLowerCase();
}

function validateSourcePath(path) {
  assert.ok(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git'), 'Source manifest paths must be normalized relative paths without .git');
  assert.ok(!path.split('/').some(part => generatedDirectories.has(part)), `Generated output cannot be a source manifest entry: ${path}`);
}

async function sourceFile(root, path) {
  validateSourcePath(path);
  // Do not follow an intermediate symlink outside the manifest's source tree.
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index++) {
    assert.ok((await lstat(join(root, ...parts.slice(0, index)))).isDirectory(), `Source parent must be a real directory: ${path}`);
  }
  const fullPath = join(root, path);
  const stat = await lstat(fullPath);
  assert.ok(stat.isFile() || stat.isSymbolicLink(), `Source entry must be a file or symlink: ${path}`);
  const symlink = stat.isSymbolicLink();
  const bytes = symlink ? Buffer.from(await readlink(fullPath), 'utf8') : await readFile(fullPath);
  return { entry: { sha256: hashBytes(bytes), symlink }, bytes, stat };
}

async function archiveFiles(root, manifestPath) {
  const paths = [];
  async function visit(directory = '') {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory ? directory + '/' + entry.name : entry.name;
      if (resolve(root, path) === manifestPath) continue;
      if (entry.isDirectory() && generatedDirectories.has(entry.name)) continue;
      validateSourcePath(path);
      if (entry.isDirectory()) await visit(path);
      else {
        assert.ok(entry.isFile() || entry.isSymbolicLink(), `Unexpected source entry: ${path}`);
        paths.push(path);
      }
    }
  }
  await visit();
  return paths.sort();
}

// This identity covers tracked Git bytes (including symlink targets), or the
// complete archive inventory supplied by the source exporter. Generated Zig
// outputs/caches and node_modules are not product source. Dependency
// resolution, the compiler and this build runner remain trusted build inputs.
export async function sourceState({ root = checkoutRoot, env = process.env } = {}) {
  root = await realpath(root);
  const sourceHead = await expectedSourceHead({ root, env });
  const files = Object.create(null);
  let kind;
  if (await hasGit(root)) {
    kind = 'git';
    assert.equal(await git(root, ['status', '--porcelain=v1', '--untracked-files=no']), '', 'Exact-source build requires clean tracked Git source (including the index)');
    const tree = (await git(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])).split('\0').filter(Boolean);
    for (const record of tree) {
      const tab = record.indexOf('\t');
      const [mode, type, object] = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      assert.ok(type === 'blob' && ['100644', '100755', '120000'].includes(mode), `Unsupported tracked source entry: ${path}`);
      const { entry, bytes, stat } = await sourceFile(root, path);
      assert.equal(entry.symlink, mode === '120000', `Git source type differs from HEAD: ${path}`);
      if (!entry.symlink) assert.equal(Boolean(stat.mode & 0o111), mode === '100755', `Git source executable mode differs from HEAD: ${path}`);
      const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(blob, object, `Git source bytes differ from HEAD: ${path}`);
      files[path] = entry;
    }
    assert.equal(await expectedSourceHead({ root, env }), sourceHead, 'Git HEAD changed while reading source');
    assert.equal(await git(root, ['status', '--porcelain=v1', '--untracked-files=no']), '', 'Tracked Git source changed while reading source');
  } else {
    kind = 'archive';
    assert.ok(env.FX_TERN_SOURCE_MANIFEST, 'A source archive without .git requires FX_TERN_SOURCE_MANIFEST for full source-file verification');
    const manifestPath = await realpath(resolve(root, env.FX_TERN_SOURCE_MANIFEST));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.ok(isObject(manifest) && isObject(manifest.files), 'Source manifest must contain {sourceHead, files}');
    assert.match(manifest.sourceHead, sourceHeadPattern, 'Source manifest sourceHead must contain exactly 40 hexadecimal characters');
    assert.equal(manifest.sourceHead.toLowerCase(), sourceHead, 'Source manifest sourceHead must match FX_TERN_EXPECTED_HEAD');
    const paths = Object.keys(manifest.files).sort();
    assert.ok(paths.length > 0, 'Source manifest must enumerate the full nonempty source tree');
    for (const path of paths) {
      validateSourcePath(path);
      const expected = manifest.files[path];
      assert.ok(isObject(expected) && typeof expected.symlink === 'boolean', `Source manifest requires sha256 and symlink:boolean: ${path}`);
      assert.match(expected.sha256, sha256Pattern, `Source manifest requires SHA-256: ${path}`);
    }
    assert.deepEqual(await archiveFiles(root, manifestPath), paths, 'Archive source inventory must exactly match the full source manifest');
    for (const path of paths) {
      const { entry } = await sourceFile(root, path);
      assert.deepEqual(entry, { sha256: manifest.files[path].sha256.toLowerCase(), symlink: manifest.files[path].symlink }, `Archive source differs from manifest: ${path}`);
      files[path] = entry;
    }
  }
  // Sort independently of Git's tree ordering and manifest JSON key ordering.
  const sortedFiles = Object.fromEntries(Object.keys(files).sort().map(path => [path, files[path]]));
  return { sourceHead, sourceIdentity: { kind, sha256: hashBytes(JSON.stringify({ sourceHead, files: sortedFiles })) } };
}

export async function assertNativeBinary(binary) {
  await access(binary, constants.X_OK);
  const handle = await open(binary, 'r');
  try {
    const magic = Buffer.alloc(4);
    assert.equal((await handle.read(magic, 0, 4, 0)).bytesRead, 4);
    assert.ok(['7f454c46', 'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex')),
      'Real fx acceptance requires a native ELF/Mach-O binary. A fake ACP script is not accepted.');
  } finally { await handle.close(); }
}

async function binarySha256(binary) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  return hash.digest('hex');
}

function validateBuildArgs(args) {
  assert.ok(Array.isArray(args) && args.every(arg => typeof arg === 'string' && (
    /^-D(?:target|cpu)=[A-Za-z0-9_+.,:-]+$/.test(arg) ||
    /^-Doptimize=(?:Debug|ReleaseSafe|ReleaseFast|ReleaseSmall)$/.test(arg) ||
    /^-j[1-9][0-9]*$/.test(arg)
  )), usage);
  const names = args.map(arg => arg.startsWith('-j') ? '-j' : arg.slice(0, arg.indexOf('=')));
  assert.equal(new Set(names).size, names.length, 'Build flags must not be repeated');
  return args;
}

export function parseBuildArgs(argv) {
  assert.ok(argv[0] === '--build' && argv[1] === '--', usage);
  return validateBuildArgs(argv.slice(2));
}

// Receipt integrity and source association, not a signature or attestation:
// anyone able to edit the runner, compiler or JSON can forge this trusted-build
// record. Native acceptance is a separate ACP/TTY interaction, never magic alone.
export function verifyBuildReceipt(receipt, { sourceHead, sha256, sourceIdentity }) {
  assert.ok(isObject(receipt), 'The build receipt must be a JSON object');
  assert.equal(receipt.version, 2, 'An enforced build receipt version 2 is required; standalone stamps are not accepted');
  assert.match(sourceHead, sourceHeadPattern, 'The expected sourceHead must contain exactly 40 hexadecimal characters');
  assert.match(sha256, sha256Pattern, 'The actual binary SHA-256 must contain exactly 64 hexadecimal characters');
  assert.match(receipt.sourceHead, sourceHeadPattern, 'The build receipt sourceHead must contain exactly 40 hexadecimal characters');
  assert.match(receipt.sha256, sha256Pattern, 'The build receipt SHA-256 must contain exactly 64 hexadecimal characters');
  assert.equal(receipt.sourceHead.toLowerCase(), sourceHead.toLowerCase(), 'The build receipt sourceHead must match the expected checkout head');
  assert.equal(receipt.sha256.toLowerCase(), sha256.toLowerCase(), 'The build receipt SHA-256 must match the actual binary');
  assert.ok(isObject(sourceIdentity) && ['git', 'archive'].includes(sourceIdentity.kind), 'The current source identity must be verified');
  assert.match(sourceIdentity.sha256, sha256Pattern, 'The current source identity requires SHA-256');
  assert.ok(isObject(receipt.sourceIdentity) && ['git', 'archive'].includes(receipt.sourceIdentity.kind), 'The build source identity must be verified');
  assert.match(receipt.sourceIdentity.sha256, sha256Pattern, 'The build source identity requires SHA-256');
  // A fleet archive and its original clean Git checkout identify the same bytes.
  assert.equal(receipt.sourceIdentity.sha256, sourceIdentity.sha256, 'The build receipt sourceIdentity must match the current exact source state');
  assert.ok(isObject(receipt.build) && receipt.build.command === 'zig' && Array.isArray(receipt.build.args) && receipt.build.args[0] === 'build', 'The receipt must record the enforced Zig build operation');
  validateBuildArgs(receipt.build.args.slice(1));
  return { sourceHead: sourceHead.toLowerCase(), sha256: sha256.toLowerCase(), sourceIdentity };
}

async function checkoutBinary(root) {
  root = await realpath(root);
  for (const directory of ['zig-out', 'zig-out/bin']) {
    try {
      assert.ok((await lstat(join(root, directory))).isDirectory(), 'The checkout output directories must not redirect through a symlink');
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return join(root, 'zig-out/bin/fx');
}

async function assertCheckoutBinary(binary, root) {
  const expected = await checkoutBinary(root);
  assert.equal(resolve(binary), expected, 'Use the exact built Zig binary from this checkout');
  assert.equal(await realpath(binary), expected, 'The checkout Zig binary must not redirect through a symlink');
  await assertNativeBinary(binary);
}

export async function readVerifiedBuildReceipt(binary, { root = checkoutRoot, env = process.env } = {}) {
  await assertCheckoutBinary(binary, root);
  const manifest = `${binary}.build.json`;
  let text;
  try { text = await readFile(manifest, 'utf8'); }
  catch (error) { throw new Error(`Cannot read required build receipt ${manifest}. Run the enforced exact-source Zig build.`, { cause: error }); }
  const state = await sourceState({ root, env });
  const receipt = verifyBuildReceipt(JSON.parse(text), { ...state, sha256: await binarySha256(binary) });
  assert.deepEqual(await sourceState({ root, env }), state, 'Source changed during build receipt verification');
  return receipt;
}

async function executeZigBuild(args, { root, env }) {
  await run('zig', ['build', ...args], { cwd: root, env, timeout: 1_800_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
}

// executeBuild is a controlled unit-test seam. The CLI always executes Zig; it
// exposes no command override or standalone stamping mode. Remove the old output
// too: a successful no-op must never associate a previous binary with this head.
export async function buildWithReceipt({ root = checkoutRoot, env = process.env, buildArgs = [], executeBuild = executeZigBuild } = {}) {
  validateBuildArgs(buildArgs);
  root = await realpath(root);
  const binary = await checkoutBinary(root);
  const manifest = `${binary}.build.json`;
  await rm(manifest, { force: true });
  const before = await sourceState({ root, env });
  await rm(binary, { force: true });
  try {
    await executeBuild([...buildArgs], { root, env });
    assert.deepEqual(await sourceState({ root, env }), before, 'Exact source state changed during Zig build');
    await assertCheckoutBinary(binary, root);
    const receipt = { version: 2, ...before, sha256: await binarySha256(binary), build: { command: 'zig', args: ['build', ...buildArgs] } };
    assert.deepEqual(await sourceState({ root, env }), before, 'Exact source state changed before receipt publication');
    await writeFile(manifest, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return { binary, ...verifyBuildReceipt(receipt, { ...before, sha256: receipt.sha256 }), manifest };
  } catch (error) {
    await rm(manifest, { force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(await buildWithReceipt({ buildArgs: parseBuildArgs(process.argv.slice(2)) })));
  } catch (error) {
    console.error(`FX Tern build receipt: ${error.message}`);
    process.exitCode = 1;
  }
}
