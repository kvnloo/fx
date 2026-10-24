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

function memoryAcp(handle = () => {}, { eof = true, terminate = true, kill = true, closeOnExit = true } = {}) {
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
  };
  const close = () => child.emit('close', child.exitCode, child.signalCode);
  const finish = (code, signal = null) => {
    exit(code, signal);
    if (closeOnExit) close();
  };
  child.stdin.on('finish', () => { if (eof && child.exitCode === null && child.signalCode === null) finish(0); });
  child.kill = signal => {
    signals.push(signal);
    const accepted = terminate || (signal === 'SIGKILL' && kill);
    if (accepted) queueMicrotask(() => finish(null, signal));
    return accepted;
  };
  return { acp: new FxAcp({ spawnProcess: () => child }), child, sent, reply, exit, close, signals };
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
  const { acp, child, exit, close } = memoryAcp(() => {}, { eof: false });
  const failures = [];
  acp.on('failed', error => failures.push(error));
  await acp.start();
  child.stdin.on('finish', () => {
    exit(23);
    child.stderr.write('native shutdown failed');
    close();
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
  const { acp, child, exit, close, signals } = memoryAcp();
  const failures = [];
  acp.on('failed', error => failures.push(error));
  await acp.start();
  const rejected = assert.rejects(acp.prompt('waiting'), /fx acp exited \(7\)/);
  child.stderr.write('fatal');
  exit(7);
  assert.equal(acp.outcome, null);
  child.stderr.write(' after exit');
  close();
  await rejected;
  assert.deepEqual(await acp.close(), { code: 7, signal: null, stderr: 'fatal after exit' });
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

test('an exited child with inherited pipes rejects at the final deadline and releases only owned streams', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { acp, child, close, signals } = memoryAcp(() => {}, { closeOnExit: false });
  const unrelated = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, unrelated];
  const failures = [];
  acp.on('failed', error => failures.push(error));
  await acp.start();
  const exit = new Promise(resolve => child.once('exit', resolve));
  const closing = acp.close();
  let cleanupFailure;
  const rejected = assert.rejects(closing, error => {
    cleanupFailure = error;
    return /cleanup incomplete.*close was not observed/.test(error.message);
  });
  try {
    await exit;
    assert.equal(child.exitCode, 0);
    assert.equal(acp.outcome, null);
    child.stderr.write('inherited descriptors still open');
    t.mock.timers.tick(1000);
    t.mock.timers.tick(1000);
    t.mock.timers.tick(999);
    assert.equal(child.stdout.destroyed, false);
    assert.equal(child.stderr.destroyed, false);
    assert.equal(acp.failure, null);
    assert.deepEqual(signals, []);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(acp.failure, cleanupFailure);
    assert.match(cleanupFailure.message, /inherited descriptors still open/);
    assert.equal(acp.outcome, null);
    assert.equal(child.stdin.destroyed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(unrelated.destroyed, false);
    assert.deepEqual(failures, []);
    assert.equal(acp.close(), closing);
    close();
    await assert.rejects(acp.close(), error => error === cleanupFailure);
  } finally { unrelated.destroy(); }
});

test('a killed child whose inherited pipes never close still fails within the final settlement bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { acp, child, signals } = memoryAcp(() => {}, { eof: false, terminate: false, closeOnExit: false });
  await acp.start();
  const closing = acp.close();
  const rejected = assert.rejects(closing, /cleanup incomplete/);
  const exit = new Promise(resolve => child.once('exit', resolve));
  t.mock.timers.tick(1000);
  assert.deepEqual(signals, ['SIGTERM']);
  t.mock.timers.tick(1000);
  await exit;
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(acp.outcome, null);
  t.mock.timers.tick(999);
  assert.equal(child.stdout.destroyed, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(acp.outcome, null);
});

test('an unkillable direct child rejects shared close instead of inventing a successful outcome', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { acp, child, signals } = memoryAcp(() => {}, { eof: false, terminate: false, kill: false });
  await acp.start();
  const pending = assert.rejects(acp.prompt('waiting'), /session closed/);
  const closing = acp.close();
  const rejected = assert.rejects(closing, /cleanup incomplete/);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  await rejected;
  await pending;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(acp.outcome, null);
  assert.match(acp.failure.message, /cleanup incomplete/);
  assert.equal(acp.pending.size, 0);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(acp.close(), closing);
});

test('a delayed close before the final deadline drains stderr and cancels every remaining timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { acp, child, exit, close, signals } = memoryAcp(() => {}, { eof: false });
  await acp.start();
  const closing = acp.close();
  exit(0);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(999);
  assert.equal(acp.failure, null);
  assert.equal(acp.outcome, null);
  assert.equal(child.stdout.destroyed, false);
  assert.equal(child.stderr.destroyed, false);
  child.stderr.write('last diagnostic after exit');
  close();
  assert.deepEqual(await closing, { code: 0, signal: null, stderr: 'last diagnostic after exit' });
  t.mock.timers.tick(10_000);
  assert.equal(acp.failure, null);
  assert.equal(child.stdout.destroyed, false);
  assert.equal(child.stderr.destroyed, false);
  assert.deepEqual(signals, []);
});

test('signal errors remain transport failures and cannot prevent bounded cleanup rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { acp, child, signals } = memoryAcp(() => {}, { eof: false });
  const signalFailure = new Error('direct child signal denied');
  child.kill = signal => { signals.push(signal); throw signalFailure; };
  await acp.start();
  const closing = acp.close();
  const rejected = assert.rejects(closing, error => {
    assert.match(error.message, /cleanup incomplete/);
    assert.equal(error.cause, signalFailure);
    return true;
  });
  t.mock.timers.tick(1000);
  assert.equal(acp.failure, signalFailure);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  await rejected;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(acp.failure, signalFailure);
  assert.equal(acp.outcome, null);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test('automatic failure cleanup retains the original failure while its close promise rejects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { acp, child } = memoryAcp(() => {}, { eof: false, terminate: false, kill: false });
  const failures = [];
  acp.on('failed', error => failures.push(error));
  await acp.start();
  const transportFailure = new Error('broken transport before cleanup');
  const request = assert.rejects(acp.prompt('waiting'), error => error === transportFailure);
  child.stdin.emit('error', transportFailure);
  await request;
  assert.ok(acp.closing);
  const closing = acp.close();
  const rejected = assert.rejects(closing, error => {
    assert.match(error.message, /cleanup incomplete/);
    assert.equal(error.cause, transportFailure);
    return true;
  });
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(acp.failure, transportFailure);
  assert.deepEqual(failures, [transportFailure]);
  assert.equal(acp.close(), closing);
  assert.equal(acp.outcome, null);
});
