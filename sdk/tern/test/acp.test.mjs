import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxAcp } from '../acp.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const fake = new URL('./fixtures/fake-fx.mjs', import.meta.url).pathname;
async function waitFor(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timeout waiting for fake FX');
}

test('ACP new session, streaming chunks, explicit permission, and prompt completion', async () => {
  const acp = new FxAcp({ binary: process.execPath, args: [fake] });
  const updates = []; const permissions = [];
  acp.on('update', value => updates.push(value));
  acp.on('permission', value => permissions.push(value));
  try {
    assert.equal(await acp.start(), 'test-session');
    const result = acp.prompt('hello');
    await waitFor(() => permissions.length === 1);
    assert.equal(acp.respondPermission(permissions[0].id, 'fake_option'), false);
    assert.equal(acp.respondPermission(permissions[0].id, 'allow_once'), true);
    assert.equal(acp.respondPermission(permissions[0].id, 'allow_once'), false);
    assert.equal((await result).stopReason, 'end_turn');
    assert.equal(updates.filter(x => x.sessionUpdate === 'agent_message_chunk').map(x => x.content.text).join(''), 'Hello world \u001b[2J🙂');
    assert.equal(updates.find(x => x.sessionUpdate === 'tool_call_update').status, 'completed');
  } finally { await acp.close(); }
});

test('ACP load uses existing session and reject denies the pending tool', async () => {
  const acp = new FxAcp({ binary: process.execPath, args: [fake] });
  let pending;
  acp.on('permission', value => { pending = value; });
  try {
    assert.equal(await acp.start({ resume: 'saved-123' }), 'saved-123');
    const prompt = acp.prompt('test');
    await waitFor(() => Boolean(pending));
    assert.equal(acp.respondPermission(pending.id, 'reject_once'), true);
    assert.equal((await prompt).stopReason, 'end_turn');
  } finally { await acp.close(); }
});

test('ACP process exit rejects requests and does not leak permission state', async () => {
  const acp = new FxAcp({ binary: process.execPath, args: ['-e', 'process.exit(42)'] });
  await assert.rejects(acp.start(), /fx acp exited/);
  assert.equal(acp.pending.size, 0);
  await acp.close();
});

function memoryAcp(handle = () => {}, { eof = true, terminate = true } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const sent = [];
  const reply = message => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  child.stdin.on('data', bytes => {
    const message = JSON.parse(bytes.toString());
    sent.push(message);
    if (message.method === 'initialize') {
      if (!handle(message, reply)) reply({ id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === 'session/new') reply({ id: message.id, result: { sessionId: 'memory-session' } });
    else handle(message, reply);
  });
  const signals = [];
  const exit = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  child.stdin.on('finish', () => { if (eof && child.exitCode === null && child.signalCode === null) exit(0); });
  child.kill = signal => {
    signals.push(signal);
    if (terminate || signal === 'SIGKILL') queueMicrotask(() => exit(null, signal));
    return true;
  };
  return { acp: new FxAcp({ spawnProcess: () => child }), child, sent, reply, exit, signals };
}

test('initialization rejects incompatible ACP versions before creating a session', async () => {
  const { acp, sent } = memoryAcp((message, reply) => {
    if (message.method !== 'initialize') return false;
    reply({ id: message.id, result: { protocolVersion: 2 } });
    return true;
  });
  try {
    await assert.rejects(acp.start(), /protocol version 1/);
    assert.equal(sent.some(message => message.method === 'session/new'), false);
  } finally { await acp.close(); }
});

test('cancel is a notification and server withdrawal invalidates a pending permission reply', async () => {
  const { acp, sent, reply } = memoryAcp();
  const cancelled = [];
  acp.on('permission_cancelled', id => cancelled.push(id));
  try {
    await acp.start();
    reply({ id: 'permission-7', method: 'session/request_permission', params: { sessionId: acp.sessionId,
      options: [{ optionId: 'yes', kind: 'allow_once' }] } });
    assert.equal(acp.permissions.size, 1);
    await acp.cancel();
    const cancel = sent.find(message => message.method === 'session/cancel');
    assert.equal(Object.hasOwn(cancel, 'id'), false);
    assert.deepEqual(cancel.params, { sessionId: acp.sessionId });
    assert.equal(acp.pending.size, 0);
    reply({ method: '$/cancel_request', params: { requestId: 'permission-7' } });
    assert.deepEqual(cancelled, ['permission-7']);
    assert.equal(acp.respondPermission('permission-7', 'yes'), false);
    assert.equal(acp.permissions.size, 0);
  } finally { await acp.close(); }
});

test('unanswerable and wrong-session permission requests receive a cancelled outcome', async () => {
  const { acp, sent, reply } = memoryAcp();
  try {
    await acp.start();
    reply({ id: 30, method: 'session/request_permission', params: { sessionId: acp.sessionId, options: [] } });
    reply({ id: 31, method: 'session/request_permission', params: { sessionId: 'other', options: [{ optionId: 'yes' }] } });
    assert.equal(acp.permissions.size, 0);
    for (const id of [30, 31]) assert.deepEqual(sent.find(message => message.id === id).result, { outcome: { outcome: 'cancelled' } });
  } finally { await acp.close(); }
});

test('close cancels every pending permission, rejects requests, and shares awaited process cleanup', async () => {
  const { acp, child, sent, reply } = memoryAcp();
  await acp.start();
  reply({ id: 40, method: 'session/request_permission', params: { sessionId: acp.sessionId, options: [{ optionId: 'yes' }] } });
  const pending = acp.prompt('waiting');
  const rejection = assert.rejects(pending, /session closed/);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const first = acp.close();
  assert.equal(acp.close(), first);
  await first; await rejection;
  assert.equal(exited, true);
  assert.equal(acp.permissions.size, 0);
  assert.equal(acp.pending.size, 0);
  assert.deepEqual(sent.find(message => message.id === 40).result, { outcome: { outcome: 'cancelled' } });
});

test('stdin failure settles requests and close still cleans the failed child', async () => {
  const { acp, child } = memoryAcp();
  await acp.start();
  const pending = acp.prompt('waiting');
  const rejection = assert.rejects(pending, /broken stdin/);
  child.stdin.emit('error', new Error('broken stdin'));
  await rejection;
  assert.equal(acp.closed, true);
  await acp.close();
  assert.deepEqual(acp.outcome, { code: 0, signal: null, stderr: '' });
  assert.equal(acp.pending.size, 0);
});

test('clean EOF shutdown preserves the outcome without signals or runtime failures', async () => {
  const { acp, signals } = memoryAcp();
  const failures = [];
  acp.on('failed', error => failures.push(error));
  await acp.start();
  const closing = acp.close();
  assert.equal(acp.close(), closing);
  assert.deepEqual(await closing, { code: 0, signal: null, stderr: '' });
  assert.deepEqual(signals, []);
  assert.deepEqual(failures, []);
});

test('nonzero EOF shutdown captures trailing stderr without spurious runtime failure', async () => {
  const { acp, child, exit } = memoryAcp(() => {}, { eof: false });
  const failures = [];
  acp.on('failed', error => failures.push(error));
  await acp.start();
  child.stdin.on('finish', () => {
    child.stderr.write('native shutdown failed');
    exit(23);
  });
  assert.deepEqual(await acp.close(), { code: 23, signal: null, stderr: 'native shutdown failed' });
  assert.deepEqual(failures, []);
});

test('shutdown waits for EOF deadline then escalates TERM to KILL only after its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { acp, signals } = memoryAcp(() => {}, { eof: false, terminate: false });
  await acp.start();
  const closing = acp.close();
  assert.deepEqual(signals, []);
  t.mock.timers.tick(999);
  assert.deepEqual(signals, []);
  t.mock.timers.tick(1);
  assert.deepEqual(signals, ['SIGTERM']);
  t.mock.timers.tick(999);
  assert.deepEqual(signals, ['SIGTERM']);
  t.mock.timers.tick(1);
  assert.deepEqual(await closing, { code: null, signal: 'SIGKILL', stderr: '' });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(acp.close(), closing);
});

test('exit before close retains the actual outcome and rejects requests once', async () => {
  const { acp, child, exit, signals } = memoryAcp();
  const failures = [];
  acp.on('failed', error => failures.push(error));
  await acp.start();
  const rejected = assert.rejects(acp.prompt('waiting'), /fx acp exited \(7\)/);
  child.stderr.write('fatal');
  exit(7);
  await rejected;
  assert.deepEqual(await acp.close(), { code: 7, signal: null, stderr: 'fatal' });
  assert.equal(failures.length, 1);
  assert.deepEqual(signals, []);
});

test('process error rejects requests and automatically cleans the child', async () => {
  const { acp, child } = memoryAcp();
  await acp.start();
  const rejected = assert.rejects(acp.prompt('waiting'), /spawn transport failed/);
  child.emit('error', new Error('spawn transport failed'));
  await rejected;
  assert.deepEqual(await acp.close(), { code: 0, signal: null, stderr: '' });
  assert.equal(acp.pending.size, 0);
});

test('EOF deadline permits SIGTERM fallback and preserves its actual signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { acp, signals } = memoryAcp(() => {}, { eof: false });
  await acp.start();
  const closing = acp.close();
  t.mock.timers.tick(1000);
  assert.deepEqual(await closing, { code: null, signal: 'SIGTERM', stderr: '' });
  t.mock.timers.tick(1000);
  assert.deepEqual(signals, ['SIGTERM']);
});
