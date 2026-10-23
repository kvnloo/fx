import assert from 'node:assert/strict';
import { constants, createReadStream } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function requiredRealBinary() {
  const requested = process.env.FX_TERN_REAL_BINARY;
  assert.ok(requested, 'Real fx acceptance is REQUIRED, not skipped. Set FX_TERN_REAL_BINARY to this checkout\'s absolute zig-out/bin/fx.');
  assert.ok(isAbsolute(requested), 'FX_TERN_REAL_BINARY must be an absolute path, not a PATH command');
  const expected = fileURLToPath(new URL('../../../../zig-out/bin/fx', import.meta.url));
  const binary = await realpath(requested);
  assert.equal(binary, await realpath(expected), 'Use the exact built Zig binary from this checkout');
  await access(binary, constants.X_OK);
  const handle = await open(binary, 'r');
  try {
    const magic = Buffer.alloc(4);
    assert.equal((await handle.read(magic, 0, 4, 0)).bytesRead, 4);
    assert.ok(['7f454c46', 'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex')),
      'Real fx acceptance requires a native ELF/Mach-O binary. A fake ACP script is not accepted.');
  } finally { await handle.close(); }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  return { binary, sha256: hash.digest('hex') };
}
