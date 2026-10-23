import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVerifiedBuildReceipt } from '../../build-receipt.mjs';

export async function requiredRealBinary() {
  const requested = process.env.FX_TERN_REAL_BINARY;
  assert.ok(requested, 'Real fx acceptance is REQUIRED, not skipped. Set FX_TERN_REAL_BINARY to this checkout\'s absolute zig-out/bin/fx.');
  assert.ok(isAbsolute(requested), 'FX_TERN_REAL_BINARY must be an absolute path, not a PATH command');
  const expected = fileURLToPath(new URL('../../../../zig-out/bin/fx', import.meta.url));
  const binary = await realpath(requested);
  assert.equal(binary, await realpath(expected), 'Use the exact built Zig binary from this checkout');
  const receipt = await readVerifiedBuildReceipt(binary);
  return { binary, ...receipt };
}
