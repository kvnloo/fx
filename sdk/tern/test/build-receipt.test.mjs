import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertNativeBinary, buildWithReceipt, expectedSourceHead, parseBuildArgs, readVerifiedBuildReceipt, sourceState, verifyBuildReceipt } from '../build-receipt.mjs';

const run = promisify(execFile);
const sourceHead = '0123456789abcdef0123456789abcdef01234567';
const otherHead = '89abcdef0123456789abcdef0123456789abcdef';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const buildArgs = ['-Dtarget=x86_64-linux', '-Dcpu=baseline', '-Doptimize=ReleaseSafe', '-j1'];
// Deliberately incomplete ELF bytes, only for the controlled build/receipt unit
// tests. Never executed, passed to requiredRealBinary, or claimed as real ACP.
const artifact = Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('owned receipt unit-test bytes\n')]);

async function ownedRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fx-tern-build-receipt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'build.zig'), 'owned build source\n');
  await writeFile(join(root, 'src/main.zig'), 'owned main source\n');
  const binary = join(root, 'zig-out/bin/fx');
  return { directory, root, binary, manifest: `${binary}.build.json` };
}

async function archive(t) {
  const fixture = await ownedRoot(t);
  fixture.sourceManifest = join(fixture.directory, 'source-manifest.json');
  fixture.files = {
    'build.zig': { sha256: sha256('owned build source\n'), symlink: false },
    'src/main.zig': { sha256: sha256('owned main source\n'), symlink: false },
  };
  fixture.env = { ...process.env, FX_TERN_EXPECTED_HEAD: sourceHead, FX_TERN_SOURCE_MANIFEST: fixture.sourceManifest };
  await saveSourceManifest(fixture);
  return fixture;
}

async function saveSourceManifest(fixture, head = sourceHead) {
  await writeFile(fixture.sourceManifest, JSON.stringify({ sourceHead: head, files: fixture.files }) + '\n');
}

async function git(root, args) {
  return (await run('git', ['-C', root, ...args])).stdout.trim();
}

async function gitSource(t) {
  const fixture = await ownedRoot(t);
  await git(fixture.root, ['init', '--quiet']);
  await git(fixture.root, ['add', 'build.zig', 'src/main.zig']);
  await git(fixture.root, ['-c', 'user.name=Receipt Unit Test', '-c', 'user.email=receipt@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Owned fixture source']);
  fixture.head = await git(fixture.root, ['rev-parse', 'HEAD']);
  fixture.env = { ...process.env, FX_TERN_EXPECTED_HEAD: fixture.head };
  return fixture;
}

async function emitArtifact(fixture) {
  await mkdir(join(fixture.root, 'zig-out/bin'), { recursive: true });
  await writeFile(fixture.binary, artifact, { mode: 0o755 });
}

async function controlledBuild(fixture, executeBuild = () => emitArtifact(fixture)) {
  return buildWithReceipt({ root: fixture.root, env: fixture.env, buildArgs, executeBuild });
}

const verified = fixture => readVerifiedBuildReceipt(fixture.binary, { root: fixture.root, env: fixture.env });
const noReceipt = fixture => assert.rejects(readFile(fixture.manifest), { code: 'ENOENT' });

function expectedReceipt(result) {
  return { sourceHead: result.sourceHead, sha256: result.sha256, sourceIdentity: result.sourceIdentity };
}

test('CLI requires enforced build mode and passes only bounded Zig build flags', () => {
  assert.deepEqual(parseBuildArgs(['--build', '--', ...buildArgs]), buildArgs);
  assert.deepEqual(parseBuildArgs(['--build', '--']), []);
  for (const argv of [[], ['zig-out/bin/fx'], ['--build'], ['--build', '--', 'test'], ['--build', '--', '--build-file', '/elsewhere/build.zig'],
    ['--build', '--', '--prefix=/elsewhere'], ['--build', '--', '-Dwasm-surface=term'], ['--build', '--', '-Doptimize=NoChecks'],
    ['--build', '--', '-j0'], ['--build', '--', '-j1', '-j2'], ['--build', '--', '-Dcpu=baseline', '-Dcpu=native']]) {
    assert.throws(() => parseBuildArgs(argv));
  }
});

test('archive artifacts verify against the identical clean Git source identity', () => {
  const digest = 'a'.repeat(64);
  const sourceDigest = 'b'.repeat(64);
  const receipt = { version: 2, sourceHead, sha256: digest,
    sourceIdentity: { kind: 'archive', sha256: sourceDigest },
    build: { command: 'zig', args: ['build', ...buildArgs] } };
  const current = { sourceHead, sha256: digest, sourceIdentity: { kind: 'git', sha256: sourceDigest } };
  assert.deepEqual(verifyBuildReceipt(receipt, current), current);
  assert.throws(() => verifyBuildReceipt(receipt, { ...current, sourceIdentity: { kind: 'git', sha256: 'c'.repeat(64) } }));
});

test('build removes the old receipt and binary before execution, then publishes exact provenance', async t => {
  const fixture = await archive(t);
  await emitArtifact(fixture);
  await writeFile(fixture.manifest, 'old standalone stamp');
  let calls = 0;
  const result = await controlledBuild(fixture, async (args, options) => {
    calls++;
    assert.deepEqual(args, buildArgs);
    assert.equal(options.root, fixture.root);
    assert.equal(options.env, fixture.env);
    await noReceipt(fixture);
    await assert.rejects(readFile(fixture.binary), { code: 'ENOENT' });
    await emitArtifact(fixture);
    await noReceipt(fixture);
  });
  assert.equal(calls, 1);
  assert.equal(result.sourceHead, sourceHead);
  assert.equal(result.sha256, sha256(artifact));
  assert.deepEqual(result.sourceIdentity, (await sourceState(fixture)).sourceIdentity);
  assert.deepEqual(await verified(fixture), expectedReceipt(result));
  const receipt = JSON.parse(await readFile(fixture.manifest, 'utf8'));
  assert.equal(receipt.version, 2);
  assert.deepEqual(receipt.build, { command: 'zig', args: ['build', ...buildArgs] });
});

test('failed execution cannot leave either an old receipt or an early success receipt', async t => {
  const fixture = await archive(t);
  await emitArtifact(fixture);
  await writeFile(fixture.manifest, 'old standalone stamp');
  await assert.rejects(controlledBuild(fixture, async () => {
    await noReceipt(fixture);
    await emitArtifact(fixture);
    throw new Error('controlled Zig build failure');
  }), /controlled Zig build failure/);
  await noReceipt(fixture);
});

test('successful no-op execution cannot stamp an existing older binary', async t => {
  const fixture = await archive(t);
  await emitArtifact(fixture);
  await assert.rejects(controlledBuild(fixture, async () => {}), { code: 'ENOENT' });
  await noReceipt(fixture);
});

test('source mutation during build prevents receipt publication', async t => {
  const fixture = await archive(t);
  await assert.rejects(controlledBuild(fixture, async () => {
    await emitArtifact(fixture);
    await writeFile(join(fixture.root, 'src/main.zig'), 'changed during build\n');
  }), /Archive source differs from manifest/);
  await noReceipt(fixture);
});

test('changing both archive source and its manifest during build still fails exact-source comparison', async t => {
  const fixture = await archive(t);
  await assert.rejects(controlledBuild(fixture, async () => {
    await emitArtifact(fixture);
    await writeFile(join(fixture.root, 'src/main.zig'), 'changed source\n');
    fixture.files['src/main.zig'].sha256 = sha256('changed source\n');
    await saveSourceManifest(fixture);
  }), /Exact source state changed during Zig build/);
  await noReceipt(fixture);
});

test('acceptance rejects binary drift, source drift, and manifest relabeling', async t => {
  const fixture = await archive(t);
  await controlledBuild(fixture);
  await writeFile(fixture.binary, Buffer.concat([artifact, Buffer.from('changed')]));
  await assert.rejects(verified(fixture), /SHA-256 must match the actual binary/);
  await emitArtifact(fixture);
  await writeFile(join(fixture.root, 'src/main.zig'), 'changed after build\n');
  await assert.rejects(verified(fixture), /Archive source differs from manifest/);
  fixture.files['src/main.zig'].sha256 = sha256('changed after build\n');
  await saveSourceManifest(fixture);
  await assert.rejects(verified(fixture), /sourceIdentity must match the current exact source state/);
});

test('receipt requires enforced-build metadata and exact head, hash, and source identity', async t => {
  const fixture = await archive(t);
  const result = await controlledBuild(fixture);
  const receipt = JSON.parse(await readFile(fixture.manifest, 'utf8'));
  const expected = expectedReceipt(result);
  assert.deepEqual(verifyBuildReceipt(receipt, expected), expected);
  assert.throws(() => verifyBuildReceipt({ sourceHead, sha256: result.sha256 }, expected), /enforced build receipt version 2/);
  assert.throws(() => verifyBuildReceipt({ ...receipt, sourceHead: otherHead }, expected), /sourceHead must match/);
  assert.throws(() => verifyBuildReceipt({ ...receipt, sourceHead: sourceHead.slice(1) }, expected), /exactly 40 hexadecimal/);
  assert.throws(() => verifyBuildReceipt({ ...receipt, sha256: 'z'.repeat(64) }, expected), /exactly 64 hexadecimal/);
  assert.throws(() => verifyBuildReceipt(receipt, { ...expected, sourceHead: 'HEAD' }), /expected sourceHead/);
  assert.throws(() => verifyBuildReceipt({ ...receipt, sourceIdentity: { ...receipt.sourceIdentity, sha256: 'a'.repeat(64) } }, expected), /sourceIdentity must match/);
  assert.throws(() => verifyBuildReceipt({ ...receipt, build: { command: 'echo', args: ['build'] } }, expected), /enforced Zig build operation/);
  assert.throws(() => verifyBuildReceipt({ ...receipt, build: { command: 'zig', args: ['build', '--build-file=elsewhere'] } }, expected), /Usage:/);
});

test('acceptance requires a receipt and never generates one', async t => {
  const fixture = await archive(t);
  await emitArtifact(fixture);
  await assert.rejects(verified(fixture), /Cannot read required build receipt/);
  await noReceipt(fixture);
});

test('archives require both an explicit exact head and a full source manifest', async t => {
  const fixture = await archive(t);
  assert.equal(await expectedSourceHead({ root: fixture.root, env: { FX_TERN_EXPECTED_HEAD: sourceHead } }), sourceHead);
  await assert.rejects(sourceState({ root: fixture.root, env: {} }), /without .git requires FX_TERN_EXPECTED_HEAD/);
  await assert.rejects(sourceState({ root: fixture.root, env: { FX_TERN_EXPECTED_HEAD: 'HEAD' } }), /exactly 40 hexadecimal/);
  await assert.rejects(sourceState({ root: fixture.root, env: { FX_TERN_EXPECTED_HEAD: sourceHead } }), /requires FX_TERN_SOURCE_MANIFEST/);
  await saveSourceManifest(fixture, otherHead);
  await assert.rejects(sourceState(fixture), /sourceHead must match FX_TERN_EXPECTED_HEAD/);
});

test('archive manifest verifies every hash, symlink type, and exact inventory', async t => {
  const fixture = await archive(t);
  fixture.files['src/main.zig'].sha256 = '0'.repeat(64);
  await saveSourceManifest(fixture);
  await assert.rejects(sourceState(fixture), /Archive source differs from manifest/);
  fixture.files['src/main.zig'] = { sha256: sha256('owned main source\n'), symlink: true };
  await saveSourceManifest(fixture);
  await assert.rejects(sourceState(fixture), /Archive source differs from manifest/);
  fixture.files['src/main.zig'].symlink = false;
  await saveSourceManifest(fixture);
  await writeFile(join(fixture.root, 'src/extra.zig'), 'unlisted product source');
  await assert.rejects(sourceState(fixture), /inventory must exactly match/);
  await rm(join(fixture.root, 'src/extra.zig'));
  await rm(join(fixture.root, 'src/main.zig'));
  await assert.rejects(sourceState(fixture), /inventory must exactly match/);
});

test('archive generated directories are excluded at any depth, but .lead controls are not broadly allowed', async t => {
  const fixture = await archive(t);
  const before = await sourceState(fixture);
  for (const directory of ['.zig-cache', 'zig-cache', 'zig-out', 'sdk/tern/node_modules', 'tools/node_modules']) {
    await mkdir(join(fixture.root, directory), { recursive: true });
    await writeFile(join(fixture.root, directory, 'owned-generated-file'), 'generated, not product source');
  }
  assert.deepEqual(await sourceState(fixture), before);
  await writeFile(join(fixture.root, '.lead-check.sh'), 'unlisted runner control');
  await assert.rejects(sourceState(fixture), /inventory must exactly match/);
});

test('a source manifest inside the source tree excludes only that exact file', async t => {
  const fixture = await archive(t);
  fixture.sourceManifest = join(fixture.root, '.lead-source-manifest.json');
  fixture.env.FX_TERN_SOURCE_MANIFEST = fixture.sourceManifest;
  await saveSourceManifest(fixture);
  await sourceState(fixture);
  await writeFile(join(fixture.root, '.lead-other.json'), '{}');
  await assert.rejects(sourceState(fixture), /inventory must exactly match/);
});

test('archive symlinks hash UTF-8 link-target bytes rather than referent contents', async t => {
  const fixture = await archive(t);
  await symlink('main.zig', join(fixture.root, 'src/alias.zig'));
  fixture.files['src/alias.zig'] = { sha256: sha256('main.zig'), symlink: true };
  await saveSourceManifest(fixture);
  await sourceState(fixture);
  await rm(join(fixture.root, 'src/alias.zig'));
  await symlink('../build.zig', join(fixture.root, 'src/alias.zig'));
  await assert.rejects(sourceState(fixture), /Archive source differs from manifest/);
});

test('archive source identity is independent of manifest object key order', async t => {
  const fixture = await archive(t);
  const before = await sourceState(fixture);
  fixture.files = Object.fromEntries(Object.entries(fixture.files).reverse());
  await saveSourceManifest(fixture);
  assert.deepEqual(await sourceState(fixture), before);
});

test('manifest rejects unsafe paths, missing symlink types, malformed hashes, and an empty file map', async t => {
  const fixture = await archive(t);
  for (const path of ['../outside.zig', '/outside.zig', 'src/../main.zig', 'src\\main.zig', '.git/config', 'zig-out/bin/fx']) {
    fixture.files = { [path]: { sha256: sha256('bytes'), symlink: false } };
    await saveSourceManifest(fixture);
    await assert.rejects(sourceState(fixture), /manifest paths|Generated output/);
  }
  fixture.files = { 'build.zig': { sha256: sha256('owned build source\n') } };
  await saveSourceManifest(fixture);
  await assert.rejects(sourceState(fixture), /symlink:boolean/);
  fixture.files['build.zig'] = { sha256: 'invalid', symlink: false };
  await saveSourceManifest(fixture);
  await assert.rejects(sourceState(fixture), /requires SHA-256/);
  fixture.files = {};
  await saveSourceManifest(fixture);
  await assert.rejects(sourceState(fixture), /full nonempty source tree/);
});

test('a supplied archive head cannot bypass a present invalid checkout .git', async t => {
  const fixture = await archive(t);
  await mkdir(join(fixture.root, '.git'));
  await assert.rejects(sourceState(fixture));
});

test('clean Git source binds the receipt to HEAD and acceptance rechecks tracked state', async t => {
  const fixture = await gitSource(t);
  const result = await controlledBuild(fixture);
  assert.equal(result.sourceHead, fixture.head);
  assert.equal(result.sourceIdentity.kind, 'git');
  assert.deepEqual(await verified(fixture), expectedReceipt(result));
  await writeFile(join(fixture.root, 'src/main.zig'), 'dirty tracked source\n');
  await assert.rejects(verified(fixture), /clean tracked Git source/);
});

test('dirty and staged Git source are rejected before execution and invalidate old receipts', async t => {
  for (const staged of [false, true]) {
    const fixture = await gitSource(t);
    await emitArtifact(fixture);
    await writeFile(fixture.manifest, 'old standalone stamp');
    await writeFile(join(fixture.root, 'src/main.zig'), 'dirty tracked source\n');
    if (staged) await git(fixture.root, ['add', 'src/main.zig']);
    await assert.rejects(controlledBuild(fixture, async () => assert.fail('dirty source must not execute Zig')), /clean tracked Git source/);
    await noReceipt(fixture);
  }
});

test('Git blob verification rejects source changes hidden by assume-unchanged', async t => {
  const fixture = await gitSource(t);
  await git(fixture.root, ['update-index', '--assume-unchanged', 'src/main.zig']);
  await writeFile(join(fixture.root, 'src/main.zig'), 'hidden dirty tracked source\n');
  await assert.rejects(sourceState(fixture), /Git source bytes differ from HEAD/);
});

test('Git source changes during execution cannot publish provenance', async t => {
  const fixture = await gitSource(t);
  await assert.rejects(controlledBuild(fixture, async () => {
    await emitArtifact(fixture);
    await writeFile(join(fixture.root, 'src/main.zig'), 'changed during build\n');
  }), /clean tracked Git source/);
  await noReceipt(fixture);
});

test('Git explicit head mismatch is rejected', async t => {
  const fixture = await gitSource(t);
  fixture.env.FX_TERN_EXPECTED_HEAD = otherHead;
  await assert.rejects(sourceState(fixture), /must match the current checkout Git HEAD/);
});

test('native guards reject ACP scripts, non-executable outputs, and alternate binary paths', async t => {
  const fixture = await archive(t);
  await assert.rejects(controlledBuild(fixture, async () => {
    await mkdir(join(fixture.root, 'zig-out/bin'), { recursive: true });
    await writeFile(fixture.binary, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  }), /native ELF\/Mach-O binary/);
  await noReceipt(fixture);
  await assert.rejects(assertNativeBinary(fixture.binary), /native ELF\/Mach-O binary/);
  await controlledBuild(fixture);
  await chmod(fixture.binary, 0o644);
  await assert.rejects(verified(fixture));
  await chmod(fixture.binary, 0o755);
  const elsewhere = join(fixture.directory, 'elsewhere');
  await writeFile(elsewhere, artifact, { mode: 0o755 });
  await assert.rejects(readVerifiedBuildReceipt(elsewhere, { root: fixture.root, env: fixture.env }), /exact built Zig binary/);
});

test('native checkout output cannot be a symlink to another executable', async t => {
  const fixture = await archive(t);
  await assert.rejects(controlledBuild(fixture, async () => {
    await mkdir(join(fixture.root, 'zig-out/bin'), { recursive: true });
    const target = join(fixture.directory, 'external-artifact');
    await writeFile(target, artifact, { mode: 0o755 });
    await symlink(target, fixture.binary);
  }), /must not redirect through a symlink/);
  await noReceipt(fixture);
});

test('redirected output directories cannot invalidate or overwrite external artifacts', async t => {
  const fixture = await archive(t);
  const external = join(fixture.directory, 'external-output');
  await mkdir(join(external, 'bin'), { recursive: true });
  const externalBinary = join(external, 'bin/fx');
  const externalReceipt = `${externalBinary}.build.json`;
  await writeFile(externalBinary, 'external binary must remain untouched');
  await writeFile(externalReceipt, 'external receipt must remain untouched');
  await symlink(external, join(fixture.root, 'zig-out'));
  await assert.rejects(controlledBuild(fixture, async () => assert.fail('redirected output must not execute Zig')), /output directories must not redirect through a symlink/);
  assert.equal(await readFile(externalBinary, 'utf8'), 'external binary must remain untouched');
  assert.equal(await readFile(externalReceipt, 'utf8'), 'external receipt must remain untouched');
});

test('a Git HEAD change during build or after publication is not relabeled as the old build', async t => {
  const fixture = await gitSource(t);
  await controlledBuild(fixture);
  await git(fixture.root, ['-c', 'user.name=Receipt Unit Test', '-c', 'user.email=receipt@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Changed fixture HEAD']);
  await assert.rejects(verified(fixture), /must match the current checkout Git HEAD/);
  fixture.env.FX_TERN_EXPECTED_HEAD = await git(fixture.root, ['rev-parse', 'HEAD']);
  await assert.rejects(verified(fixture), /sourceHead must match the expected checkout head/);
  await assert.rejects(controlledBuild(fixture, async () => {
    await emitArtifact(fixture);
    await git(fixture.root, ['-c', 'user.name=Receipt Unit Test', '-c', 'user.email=receipt@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'HEAD changed during build']);
    fixture.env.FX_TERN_EXPECTED_HEAD = await git(fixture.root, ['rev-parse', 'HEAD']);
  }), /Exact source state changed during Zig build/);
  await noReceipt(fixture);
});
