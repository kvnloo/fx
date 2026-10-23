import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxAcp } from '../acp.mjs';

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
