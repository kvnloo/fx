#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceHeadPattern = /^[0-9a-f]{40}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;

export async function expectedSourceHead({ root = checkoutRoot, env = process.env } = {}) {
  const supplied = env.FX_TERN_EXPECTED_HEAD;
  if (supplied !== undefined) assert.match(supplied, sourceHeadPattern, 'FX_TERN_EXPECTED_HEAD must contain exactly 40 hexadecimal characters');
  try {
    await lstat(join(root, '.git'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    assert.ok(supplied, 'A source archive without .git requires FX_TERN_EXPECTED_HEAD from the exact build source');
    return supplied.toLowerCase();
  }
  const { stdout } = await run('git', ['-C', root, '--git-dir=.git', 'rev-parse', '--verify', 'HEAD^{commit}']);
  const head = stdout.trim();
  assert.match(head, sourceHeadPattern, 'The checkout Git HEAD must contain exactly 40 hexadecimal characters');
  if (supplied !== undefined) assert.equal(supplied.toLowerCase(), head.toLowerCase(), 'FX_TERN_EXPECTED_HEAD must match the current checkout Git HEAD');
  return head.toLowerCase();
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

// This checks receipt integrity only. requiredRealBinary also enforces the
// checkout output path, executable permission, and native ELF/Mach-O format.
export function verifyBuildReceipt(receipt, { sourceHead, sha256 }) {
  assert.ok(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'The build receipt must be a JSON object');
  assert.match(sourceHead, sourceHeadPattern, 'The expected sourceHead must contain exactly 40 hexadecimal characters');
  assert.match(sha256, sha256Pattern, 'The actual binary SHA-256 must contain exactly 64 hexadecimal characters');
  assert.match(receipt.sourceHead, sourceHeadPattern, 'The build receipt sourceHead must contain exactly 40 hexadecimal characters');
  assert.match(receipt.sha256, sha256Pattern, 'The build receipt SHA-256 must contain exactly 64 hexadecimal characters');
  assert.equal(receipt.sourceHead.toLowerCase(), sourceHead.toLowerCase(), 'The build receipt sourceHead must match the expected checkout head');
  assert.equal(receipt.sha256.toLowerCase(), sha256.toLowerCase(), 'The build receipt SHA-256 must match the actual binary');
  return { sourceHead: sourceHead.toLowerCase(), sha256: sha256.toLowerCase() };
}

export async function readVerifiedBuildReceipt(binary, sourceHead) {
  const manifest = `${binary}.build.json`;
  let text;
  try { text = await readFile(manifest, 'utf8'); }
  catch (error) { throw new Error(`Cannot read required build receipt ${manifest}. Generate it after the actual exact-head build.`, { cause: error }); }
  const receipt = JSON.parse(text);
  return verifyBuildReceipt(receipt, { sourceHead, sha256: await binarySha256(binary) });
}

// The build runner invokes this command only after its actual build succeeds.
// Never generate a receipt from an acceptance guard. Native magic checks do not
// execute the binary, so macOS can record a Linux cross-build without emulation.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.ok(process.argv.length <= 3, 'Usage: node sdk/tern/build-receipt.mjs [BINARY]');
    const binary = await realpath(process.argv[2] || join(checkoutRoot, 'zig-out/bin/fx'));
    const sourceHead = await expectedSourceHead();
    await assertNativeBinary(binary);
    const receipt = { sourceHead, sha256: await binarySha256(binary) };
    const manifest = `${binary}.build.json`;
    await writeFile(manifest, JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify({ binary, ...receipt, manifest }));
  } catch (error) {
    console.error(`FX Tern build receipt: ${error.message}`);
    process.exitCode = 1;
  }
}
