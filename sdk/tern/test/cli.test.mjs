import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../cli.mjs', import.meta.url).pathname;
const fake = new URL('./fixtures/fake-fx.mjs', import.meta.url).pathname;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('full CLI-to-ACP-to-plain-PTY fallback with an explicit permission choice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-tern-cli-'));
  const shim = join(dir, 'fx');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [cli, '--fx', shim], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERN_TSP: '0' } });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  async function until(needle) {
    for (let i = 0; i < 250; i++) { if (stdout.includes(needle)) return; await delay(10); }
    throw new Error(`missing ${needle}: ${stdout}; stderr ${stderr}`);
  }
  try {
    await until('fx> ');
    child.stdin.write('hello\n');
    await until('permission> ');
    assert.match(stdout, /Write fixture/);
    child.stdin.write('2\n');
    await until('world �[2J🙂');
    child.stdin.write('/quit\n');
    const status = await Promise.race([new Promise(resolve => child.once('exit', code => resolve(code))), delay(2500).then(() => -1)]);
    assert.equal(status, 0, `stderr: ${stderr}; stdout: ${stdout}`);
    assert.equal(stdout.includes('\u001b'), false);
    assert.equal(stderr, '');
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
});
