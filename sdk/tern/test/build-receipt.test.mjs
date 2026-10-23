import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNativeBinary, expectedSourceHead, readVerifiedBuildReceipt, verifyBuildReceipt } from '../build-receipt.mjs';

const sourceHead = '0123456789abcdef0123456789abcdef01234567';
const otherHead = '89abcdef0123456789abcdef0123456789abcdef';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function ownedArtifact(t) {
  const root = await mkdtemp(join(tmpdir(), 'fx-tern-build-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'artifact');
  // These bytes exercise receipt integrity only. They are not a native binary,
  // and no test passes them to requiredRealBinary or runs them as an ACP agent.
  const bytes = Buffer.from('owned artifact bytes from the current build\n');
  await writeFile(binary, bytes);
  const receipt = { sourceHead, sha256: sha256(bytes) };
  return { root, binary, manifest: `${binary}.build.json`, receipt };
}

async function saveReceipt(fixture, receipt = fixture.receipt) {
  await writeFile(fixture.manifest, JSON.stringify(receipt) + '\n');
}

test('receipt integrity returns the verified source head and actual artifact hash', async t => {
  const fixture = await ownedArtifact(t);
  await saveReceipt(fixture);
  assert.deepEqual(await readVerifiedBuildReceipt(fixture.binary, sourceHead), fixture.receipt);
});

test('receipt integrity rejects a stale binary left under the same output path', async t => {
  const fixture = await ownedArtifact(t);
  await saveReceipt(fixture);
  await writeFile(fixture.binary, 'owned artifact bytes from an older build\n');
  await assert.rejects(readVerifiedBuildReceipt(fixture.binary, sourceHead), /SHA-256 must match the actual binary/);
});

test('receipt integrity rejects a matching artifact hash from the wrong source head', async t => {
  const fixture = await ownedArtifact(t);
  await saveReceipt(fixture, { ...fixture.receipt, sourceHead: otherHead });
  await assert.rejects(readVerifiedBuildReceipt(fixture.binary, sourceHead), /sourceHead must match the expected checkout head/);
});

test('receipt integrity requires a manifest and never generates one', async t => {
  const fixture = await ownedArtifact(t);
  await assert.rejects(readVerifiedBuildReceipt(fixture.binary, sourceHead), /Cannot read required build receipt/);
  await assert.rejects(readFile(fixture.manifest), { code: 'ENOENT' });
});

test('receipt integrity rejects malformed source heads and binary hashes', () => {
  const receipt = { sourceHead, sha256: sha256('owned bytes') };
  assert.throws(() => verifyBuildReceipt({ ...receipt, sourceHead: sourceHead.slice(1) }, receipt), /sourceHead must contain exactly 40 hexadecimal characters/);
  assert.throws(() => verifyBuildReceipt({ ...receipt, sha256: 'z'.repeat(64) }, receipt), /SHA-256 must contain exactly 64 hexadecimal characters/);
  assert.throws(() => verifyBuildReceipt(receipt, { ...receipt, sourceHead: 'HEAD' }), /expected sourceHead must contain exactly 40 hexadecimal characters/);
});

test('a source archive requires an explicit exact head', async t => {
  const { root } = await ownedArtifact(t);
  assert.equal(await expectedSourceHead({ root, env: { FX_TERN_EXPECTED_HEAD: sourceHead } }), sourceHead);
  await assert.rejects(expectedSourceHead({ root, env: {} }), /without .git requires FX_TERN_EXPECTED_HEAD/);
  await assert.rejects(expectedSourceHead({ root, env: { FX_TERN_EXPECTED_HEAD: 'HEAD' } }), /exactly 40 hexadecimal characters/);
});

test('an explicit archive head cannot bypass a present but invalid checkout .git', async t => {
  const { root } = await ownedArtifact(t);
  await mkdir(join(root, '.git'));
  await assert.rejects(expectedSourceHead({ root, env: { FX_TERN_EXPECTED_HEAD: sourceHead } }));
});

test('native acceptance still rejects an executable ACP script', async t => {
  const { root } = await ownedArtifact(t);
  const script = join(root, 'fake-acp');
  await writeFile(script, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  await assert.rejects(assertNativeBinary(script), /native ELF\/Mach-O binary/);
});
