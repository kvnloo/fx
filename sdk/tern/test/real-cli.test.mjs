import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { requiredRealBinary } from './fixtures/real-binary.mjs';
import { startRealProvider, userPromptCount } from './fixtures/real-provider.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const ptyHelper = fileURLToPath(new URL('./fixtures/real-cli-pty.py', import.meta.url));

// Newlines submit independent readline turns. This gate tests supported single-line
// Unicode input, not multiline paste. real-acp.test.mjs owns exact multiline proof.
test('REQUIRED real CLI ordinary-terminal fallback on an OS PTY: Unicode line, file permissions, /quit, cooked tty (synthetic provider)', { timeout: 90_000 }, async t => {
  const identity = await requiredRealBinary();
  const fixture = await startRealProvider({ singleLine: true });
  const driver = spawn(process.env.FX_TERN_REAL_PYTHON || 'python3', [ptyHelper, process.execPath, cli, '--fx', identity.binary], {
    cwd: fixture.workspace, env: { ...fixture.env, TERN_TSP: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const changed = new EventEmitter();
  let transcript = '';
  let stderr = '';
  let buffer = '';
  let failure;
  let ready;
  let exit;
  let closed = false;
  driver.stdout.setEncoding('utf8');
  driver.stderr.setEncoding('utf8');
  driver.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === 'output') transcript += event.text;
        else if (event.type === 'ready') ready = event;
        else if (event.type === 'exit') exit = event;
        else if (event.type === 'error') failure = new Error(event.message);
        else failure = new Error('Unexpected OS-PTY helper event');
      } catch (error) { failure = error; }
      changed.emit('change');
    }
  });
  driver.stderr.on('data', chunk => { stderr += chunk; changed.emit('change'); });
  driver.on('error', error => { failure = error; changed.emit('change'); });
  driver.on('close', () => { closed = true; changed.emit('change'); });
  t.after(async () => {
    try {
      if (!closed) {
        driver.stdin.end();
        await once(driver, 'close', { signal: AbortSignal.timeout(10_000) });
      }
    } finally { await fixture.close(); }
  });
  const screen = () => transcript.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');
  function until(predicate) {
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        changed.off('change', inspect);
        if (error) reject(error);
        else resolve();
      };
      const inspect = () => {
        if (failure) finish(failure);
        else if (predicate()) finish();
        else if (closed) finish(new Error(`OS-PTY driver exited early: ${stderr}\n${transcript}`));
      };
      const timer = setTimeout(() => finish(new Error(`Real CLI PTY event timed out: ${stderr}\n${transcript}`)), 15_000);
      changed.on('change', inspect);
      inspect();
    });
  }
  const send = text => driver.stdin.write(JSON.stringify({ type: 'write', text }) + '\n');
  const completed = (reply, from) => until(() => {
    const visible = screen().slice(from);
    const index = visible.indexOf(reply);
    return index !== -1 && visible.slice(index + reply.length).includes('fx> ');
  });

  await until(() => ready && screen().includes('fx> '));
  assert.equal(ready.stdinIsTTY, true, 'The child must receive a genuine OS terminal');
  assert.ok(ready.tty.startsWith('/dev/'), 'The helper must allocate a real PTY slave');
  assert.equal(ready.before.cooked, true);
  assert.match(screen(), /FX ACP session .+\. Type \/quit to exit\./, 'The actual CLI must select the ordinary readline fallback');
  assert.equal(fixture.requests.length, 0);

  for (const prompt of Object.values(fixture.prompts)) assert.doesNotMatch(prompt, /[\r\n]/);
  let from = screen().length;
  send(fixture.prompts.unicode + '\r');
  await completed(fixture.expected.unicodeReply, from);
  assert.equal(fixture.requests.length, 1);
  assert.equal(userPromptCount(fixture.requests[0].body, fixture.prompts.unicode), 1);

  from = screen().length;
  send(fixture.prompts.allow + '\r');
  await until(() => screen().slice(from).includes('permission> '));
  assert.match(screen().slice(from), /1\. Allow once/);
  assert.match(screen().slice(from), /3\. Reject/);
  assert.equal(await readFile(fixture.targets.allowed, 'utf8'), fixture.expected.seed, 'The pending real file operation must not execute before consent');
  assert.equal(fixture.requests.length, 2);
  send('1\r');
  await completed(fixture.expected.allowReply, from);
  assert.equal(await readFile(fixture.targets.allowed, 'utf8'), fixture.expected.allowed);
  assert.equal(fixture.requests.length, 3);

  from = screen().length;
  send(fixture.prompts.reject + '\r');
  await until(() => screen().slice(from).includes('permission> '));
  assert.equal(await readFile(fixture.targets.rejected, 'utf8'), fixture.expected.seed);
  assert.equal(fixture.requests.length, 4);
  send('3\r');
  await completed(fixture.expected.rejectReply, from);
  assert.equal(await readFile(fixture.targets.rejected, 'utf8'), fixture.expected.seed, 'The explicitly rejected real file operation must not execute');
  fixture.assertComplete({ resumed: false });

  send('/quit\r');
  await until(() => exit !== undefined);
  await until(() => closed);
  assert.equal(exit.code, 0, 'The actual CLI must exit normally after /quit');
  assert.equal(driver.exitCode, 0, 'The OS-PTY driver must exit normally');
  assert.equal(exit.after.cooked, true, 'The terminal must restore ICANON, ECHO, and ISIG');
  assert.equal(exit.restored, true, 'The CLI must restore the full original termios attributes');
  assert.equal(stderr, '', 'The OS-PTY helper must not emit Python errors');
  assert.doesNotMatch(screen(), /FX Tern:/, 'The actual CLI must not report a fatal error');
  t.diagnostic(JSON.stringify({
    gate: 'real-cli-os-pty-fallback', provider: 'synthetic-loopback-only', binary: identity.binary, sha256: identity.sha256,
    inputCoverage: 'single-line-unicode-only; fallback has no multiline composer', ternTsp: '0',
    httpRequests: fixture.requests.length, permissions: ['allow_once', 'reject_once'],
    quitExit: exit.code, cookedBefore: ready.before.cooked, cookedAfter: exit.after.cooked, termiosRestored: exit.restored,
  }));
});
