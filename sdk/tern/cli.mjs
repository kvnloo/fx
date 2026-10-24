#!/usr/bin/env node
import { FxAcp } from './acp.mjs';
import { FxTernFrontend } from './frontend.mjs';

function argumentsFor(argv) {
  const options = { binary: process.env.FX_TERN_BIN || './zig-out/bin/fx', resume: undefined };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--fx' && argv[i + 1]) options.binary = argv[++i];
    else if (value === '--resume' && argv[i + 1]) options.resume = argv[++i];
    else if (value === '--help') { console.log('Usage: node sdk/tern/cli.mjs [--fx ./zig-out/bin/fx] [--resume SESSION_ID]'); process.exit(0); }
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

try {
  const { binary, resume } = argumentsFor(process.argv.slice(2));
  // The optional SDK is isolated from the native Zig build and fx acp clients.
  let sdk = null;
  try { sdk = await import('@stencil-hq/tern'); }
  catch (err) { if (process.stdin.isTTY) console.error('Tern SDK unavailable: run npm install in sdk/tern. Falling back to text.'); }
  const acp = new FxAcp({ binary });
  await new FxTernFrontend({ acp, sdk }).run({ resume });
} catch (err) {
  console.error(`FX Tern: ${err.message}`);
  process.exitCode = 1;
}
