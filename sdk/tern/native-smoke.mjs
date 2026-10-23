#!/usr/bin/env node
/** Actual Tern control driver. Requires an explicitly owned headless-Sway Tern window. */
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRealProvider } from './test/fixtures/real-provider.mjs';
import { requiredRealBinary } from './test/fixtures/real-binary.mjs';
import { assertExactFirstSend, composerWitnesses } from './test/fixtures/native-wire.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const endpoint = process.env.TERN_NATIVE_CONTROL;
const receipt = process.env.TERN_NATIVE_RECEIPT;
const { binary, sha256, sourceHead } = await requiredRealBinary();
assert.ok(endpoint?.startsWith('/'), 'TERN_NATIVE_CONTROL must name the owned Unix control socket');
assert.ok(receipt?.startsWith('/'), 'TERN_NATIVE_RECEIPT must name an absolute evidence directory');
assert.ok(binary?.startsWith('/'), 'FX_TERN_REAL_BINARY must name the exact-head built binary');
assert.equal(process.env.TERN_NATIVE_OWNED_SWAY, '1', 'Confirm owned headless Sway before running');
await mkdir(dirname(receipt), { recursive: true, mode: 0o700 });
await mkdir(receipt, { mode: 0o700 });
const runId = randomUUID();
const fixture = await startRealProvider({ withCancel: true });
const log = [];
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
async function command(text) {
  const reply = await new Promise((resolveReply, reject) => {
    const socket = connect(endpoint);
    let result = '';
    let settled = false;
    socket.setTimeout(30_000, () => socket.destroy(new Error(`Tern command timed out: ${text}`)));
    socket.on('error', reject);
    socket.on('end', () => {
      if (!settled) reject(Object.assign(new Error('Tern control connection closed before its reply'), { code: 'ECONNRESET' }));
    });
    socket.on('connect', () => socket.write(text + '\n'));
    socket.on('data', chunk => {
      result += chunk;
      const end = result.indexOf('\n');
      if (end !== -1) {
        settled = true;
        socket.end();
        try { resolveReply(JSON.parse(result.slice(0, end))); } catch (error) { reject(error); }
      }
    });
  });
  log.push({ command: text, reply });
  assert.equal(reply.ok, true, `${text}: ${JSON.stringify(reply)}`);
  return reply;
}
async function waitFor(predicate, message, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    assert.deepEqual(fixture.failures, [], 'Synthetic provider rejected a runtime request');
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
}
async function snapshot(name) {
  await writeFile(join(receipt, `${name}-state.json`), JSON.stringify(await command('state'), null, 2));
  await writeFile(join(receipt, `${name}-tree.json`), JSON.stringify(await command('tree .sf'), null, 2));
  if (process.env.TERN_NATIVE_DISPLAY_WRAPPER) {
    assert.ok(process.env.TERN_NATIVE_DISPLAY_WRAPPER.startsWith('/'));
    await promisify(execFile)(process.env.TERN_NATIVE_DISPLAY_WRAPPER, ['screenshot', join(receipt, `${name}.png`)]);
  } else await command(`shot fx-${name}`);
}
async function readyEditor() {
  await waitFor(async () => {
    const editor = await command('tree .sf-editor');
    const status = await command('tree .sf-status');
    return JSON.stringify(editor).includes('sf-editor') && JSON.stringify(status).includes('Ready');
  }, 'Native editor did not become ready');
}
async function send(text) {
  await readyEditor();
  await command('click ".sf-editor"');
  await command(`type ${JSON.stringify(text)}`);
  await command('key Enter');
}
let launched = false;
try {
  const state = await command('state');
  assert.equal(state.focused?.prompt, true, 'Launch only into a confirmed owned idle shell');
  assert.ok(!state.focused?.running, 'Foreground must be the owned shell, not another app');
  const env = { ...fixture.env, TERN_TSP_RECORD: join(receipt, 'wire.jsonl') };
  const launcher = join(receipt, 'app.mjs');
  await writeFile(launcher, `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(join(receipt, 'app.pid'))}, String(process.pid));\nprocess.on('exit', code => writeFileSync(${JSON.stringify(join(receipt, 'app-exit.json'))}, JSON.stringify({code, raw:process.stdin.isRaw})));\nconst {FxAcp}=await import(${JSON.stringify(pathToFileURL(join(root, 'sdk/tern/acp.mjs')).href)});\nconst close=FxAcp.prototype.close;\nFxAcp.prototype.close=function(...args){return close.apply(this,args).then(outcome=>{writeFileSync(${JSON.stringify(join(receipt, 'app-fx-exit.json'))},JSON.stringify(outcome));return outcome;});};\nawait import(${JSON.stringify(pathToFileURL(join(root, 'sdk/tern/cli.mjs')).href)});\n`);
  const launch = `cd ${quote(fixture.workspace)} && env -i ${Object.entries(env).map(([key, value]) => quote(`${key}=${value}`)).join(' ')} ${quote(process.execPath)} ${quote(launcher)} --fx ${quote(binary)}`;
  await writeFile(join(receipt, 'launch.sh'), launch + '\n', { mode: 0o700 });
  const relay = `script --quiet --return --flush --command ${quote(`sh ${quote(join(receipt, 'launch.sh'))}`)} ${quote(join(receipt, 'pty-output.log'))}`;
  await command(`run ${JSON.stringify(relay)}`);
  launched = true;
  await readyEditor();
  await command('click ".sf-editor"');
  const original = 'Original multiline draft\n東京 café';
  await command(`type ${JSON.stringify(original)}`);
  await command(`a11y set-text-selection ".sf-editor" 0 ${original.length}`);
  await command(`type ${JSON.stringify(fixture.prompts.unicode)}`);
  await waitFor(async () => {
    const records = (await readFile(join(receipt, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    return composerWitnesses(records).text === fixture.prompts.unicode;
  }, 'Rendered composer does not equal the exact Unicode replacement');
  await snapshot('unicode-edited');
  await command('key Enter');
  await waitFor(() => fixture.requests.length === 1, 'Unicode prompt did not reach real FX');
  await readyEditor();
  await command('size 1024 720');
  await command('split right');
  await command('focus left');
  await command('size 1280 800');
  await snapshot('resized');
  await send(fixture.prompts.allow);
  await waitFor(async () => JSON.stringify(await command('tree .sf-dock button')).includes('Allow once'), 'Actual FX approval did not appear');
  assert.equal(await readFile(fixture.targets.allowed, 'utf8'), fixture.expected.seed);
  await snapshot('allow-pending');
  await command('click ".sf-dock button:nth-of-type(1)"');
  await waitFor(() => fixture.requests.length === 3, 'Allow decision did not complete');
  await readyEditor();
  assert.equal(await readFile(fixture.targets.allowed, 'utf8'), fixture.expected.allowed);
  await send(fixture.prompts.reject);
  await waitFor(async () => JSON.stringify(await command('tree .sf-dock button')).includes('Reject'), 'Actual reject option did not appear');
  await snapshot('reject-pending');
  await command('click ".sf-dock button:nth-of-type(3)"');
  await waitFor(() => fixture.requests.length === 5, 'Reject decision did not complete');
  await readyEditor();
  assert.equal(await readFile(fixture.targets.rejected, 'utf8'), fixture.expected.seed);
  if (fixture.prompts.cancel) {
    await send(fixture.prompts.cancel);
    await waitFor(() => fixture.cancellation.started, 'Cancellation turn did not start');
    await command('key Escape');
    await readyEditor();
    await waitFor(() => fixture.cancellation.disconnected, 'Real provider stream was not cancelled');
    await snapshot('cancelled');
  }
  const reattachDraft = 'Unsent reattach draft 東京';
  if (process.env.TERN_NATIVE_REATTACH === '1') {
    await command('click ".sf-editor"');
    await command(`type ${JSON.stringify(reattachDraft)}`);
  }
  await writeFile(join(receipt, 'reattach-ready.json'), JSON.stringify({ runId, endpoint, state: await command('state') }, null, 2));
  console.log('NATIVE_REATTACH_READY');
  if (process.env.TERN_NATIVE_REATTACH === '1') {
    await waitFor(async () => {
      try { await command('state'); return false; }
      catch (error) {
        if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) return true;
        throw error;
      }
    }, 'The owned Tern window never detached', 300_000);
    await writeFile(join(receipt, 'detached.json'), JSON.stringify({ runId, observedAt: Date.now() }));
    await waitFor(async () => {
      try { return JSON.parse(await readFile(join(receipt, 'reattached'), 'utf8')).runId === runId; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'No fresh acknowledgement for the owned reattached window', 300_000);
    await readyEditor();
    assert.ok(JSON.stringify(await command('tree .sf-editor')).includes(reattachDraft), 'Reattached editor must retain the unsent draft');
    assert.equal(fixture.requests.length, 6, 'Reattachment must not submit a prompt');
    await command(`a11y set-text-selection ".sf-editor" 0 ${reattachDraft.length}`);
    await command('key Backspace');
    await snapshot('reattached');
  }
  await snapshot('before-exit');
  await command('key Escape');
  await waitFor(async () => (await command('state')).focused?.prompt === true, 'Following shell did not regain its prompt');
  await delay(20_000);
  await snapshot('following-shell');
  const shell = await command('state');
  assert.ok(!shell.focused.running, 'No foreground command may remain after native exit');
  assert.equal(shell.focused.last?.status ?? shell.focused.last_status ?? 0, 0);
  const appExit = JSON.parse(await readFile(join(receipt, 'app-exit.json'), 'utf8'));
  assert.equal(appExit.code, 0);
  assert.equal(appExit.raw, false, 'Actual Node app must restore raw mode before the relay restores its parent tty');
  const fxExit = JSON.parse(await readFile(join(receipt, 'app-fx-exit.json'), 'utf8'));
  assert.equal(fxExit.code, 0, 'The actual FX subprocess must exit normally');
  assert.equal(fxExit.signal, null);
  assert.equal(fxExit.stderr, '', 'FX stderr must be clean');
  const sentinel = join(receipt, 'following-shell-sentinel.txt');
  const tty = join(receipt, 'following-shell-tty.txt');
  const sentinelValue = `FX_TERN_FOLLOWING_SHELL_OK:${runId}`;
  await command(`run ${JSON.stringify(`stty -a > ${quote(tty)} && printf %s ${quote(sentinelValue)} > ${quote(sentinel)}`)}`);
  await waitFor(async () => {
    try { return await readFile(sentinel, 'utf8') === sentinelValue; } catch { return false; }
  }, 'Following shell did not execute the exact sentinel command');
  await command('ready');
  const completedShell = await command('state');
  assert.equal(completedShell.focused.prompt, true);
  assert.equal(completedShell.focused.last?.status ?? completedShell.focused.last_status ?? 0, 0);
  const ttyState = await readFile(tty, 'utf8');
  assert.match(ttyState, /\bicanon\b/);
  assert.doesNotMatch(ttyState, /-icanon|-echo\b/);
  await fixture.assertComplete({ resumed: false });
  const records = (await readFile(join(receipt, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const hello = records.find(record => record.dir === 'in' && record.verb === 'r' && record.body.r === 'hello');
  assert.equal(hello?.body.term, 'tern', 'The peer must be actual Tern');
  assert.equal(hello.body.ver, '0.9.5');
  const lastSent = new Map();
  const lastAck = new Map();
  for (const record of records) {
    if (record.dir === 'out' && record.verb === 'f') {
      lastSent.set(record.body.sf, record.body.s);
      assert.ok(record.body.s - (lastAck.get(record.body.sf) ?? 0) <= hello.body.credits, 'Frames must respect negotiated credits');
    }
    if (record.dir === 'in' && record.body.ev === 'ack') {
      assert.ok(record.body.s <= (lastSent.get(record.body.sf) ?? 0), 'ACK must refer to a sent frame');
      lastAck.set(record.body.sf, Math.max(lastAck.get(record.body.sf) ?? 0, record.body.s));
    }
  }
  assert.ok(records.some(record => record.dir === 'in' && record.body.ev === 'edit'));
  assertExactFirstSend(records, fixture.prompts.unicode);
  const rawOutput = await readFile(join(receipt, 'pty-output.log'), 'utf8');
  assert.ok(rawOutput.includes('\x1b_tsp;x;'), 'Actual PTY output must include the close packet omitted by SDK recording');
  await writeFile(join(receipt, 'result.json'), JSON.stringify({ passed: true, runId, sourceHead, binary, sha256, fxExit, requests: fixture.requests.length, reattached: process.env.TERN_NATIVE_REATTACH === '1', syntheticProvider: true }, null, 2));
  console.log('NATIVE_FX_PASS');
} catch (error) {
  await writeFile(join(receipt, 'result.json'), JSON.stringify({ passed: false, error: error.message, launched, providerFailures: fixture.failures }, null, 2));
  throw error;
} finally {
  await writeFile(join(receipt, 'commands.json'), JSON.stringify(log, null, 2));
  await writeFile(join(receipt, 'http.json'), JSON.stringify(fixture.requests, null, 2));
  try {
    const pid = Number(await readFile(join(receipt, 'app.pid'), 'utf8'));
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    if (Number.isSafeInteger(pid) && cmdline.includes(join(receipt, 'app.mjs'))) process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }
  await fixture.close();
}
