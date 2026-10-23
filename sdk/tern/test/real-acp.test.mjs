import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { FxAcp } from '../acp.mjs';
import { ALLOW_CALL_ID, REJECT_CALL_ID, startRealProvider, userPromptCount } from './fixtures/real-provider.mjs';
import { requiredRealBinary } from './fixtures/real-binary.mjs';


async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'close', { signal: AbortSignal.timeout(10_000) });
}

async function exitThroughEof(acp) {
  assert.equal(acp.pending.size, 0, 'All real ACP requests must settle before exit');
  assert.equal(acp.permissions.size, 0, 'No permission request may remain unanswered');
  const child = acp.child;
  child.stdin.end();
  await waitForExit(child);
  assert.equal(child.exitCode, 0, 'Real fx acp must exit cleanly on stdin EOF');
  assert.equal(child.signalCode, null, 'A killed process is not a successful ACP exit');
  assert.equal(acp.stderr, '', 'Real fx acp stderr must remain clean');
}

function agentText(updates) {
  return updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content?.text ?? '').join('');
}

async function gatedWrite(acp, fixture, updates, { prompt, callId, target, content, optionId, finalText }) {
  const permissionEvent = once(acp, 'permission', { signal: AbortSignal.timeout(15_000) });
  const result = acp.prompt(prompt);
  const [permission] = await Promise.race([
    permissionEvent,
    result.then(() => { throw new Error('Real fx completed a file operation without the required permission gate'); }),
  ]);
  assert.equal(permission.sessionId, acp.sessionId);
  assert.equal(permission.toolCall.toolCallId, callId);
  assert.equal(permission.toolCall.name, 'write_file');
  assert.equal(permission.toolCall.status, 'pending');
  assert.deepEqual(permission.toolCall.rawInput, { path: target, content });
  assert.equal(await readFile(target, 'utf8'), fixture.expected.seed, 'The owned file must remain unchanged while permission is pending');
  assert.ok(updates.some(update => update.toolCallId === callId && update.status === 'pending'));
  assert.equal(acp.respondPermission(permission.id, 'not_a_real_option'), false);
  assert.equal(await readFile(target, 'utf8'), fixture.expected.seed, 'Invalid permission options must not authorize execution');
  assert.ok(permission.options.some(option => option.optionId === optionId));
  assert.equal(acp.respondPermission(permission.id, optionId), true);
  assert.equal(acp.respondPermission(permission.id, optionId), false, 'Each permission response must apply once');
  assert.equal((await result).stopReason, 'end_turn');
  assert.ok(agentText(updates).includes(finalText));
  const terminalStatus = optionId === 'allow_once' ? 'completed' : 'failed';
  assert.ok(updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === callId && update.status === terminalStatus));
  assert.equal(await readFile(target, 'utf8'), optionId === 'allow_once' ? content : fixture.expected.seed);
}

test('REQUIRED real Zig fx ACP: Unicode HTTP boundary, owned-file allow/reject, persistence, resume, EOF exit (synthetic provider)', { timeout: 90_000 }, async t => {
  const identity = await requiredRealBinary();
  const fixture = await startRealProvider();
  const clients = [];
  t.after(async () => {
    try {
      for (const client of clients) {
        await client.close();
        if (client.child) await waitForExit(client.child);
      }
    } finally { await fixture.close(); }
  });
  const createClient = () => {
    const client = new FxAcp({ binary: identity.binary, args: ['acp'], cwd: fixture.workspace, env: fixture.env });
    clients.push(client);
    return client;
  };
  const acp = createClient();
  const updates = [];
  const permissions = [];
  acp.on('update', update => updates.push(update));
  acp.on('permission', permission => permissions.push(permission));
  const sessionId = await acp.start();
  assert.match(sessionId, /^[A-Za-z0-9_-]+$/);
  assert.equal(fixture.requests.length, 0, 'Initialization must not contact a model or external service');

  assert.equal((await acp.prompt(fixture.prompts.unicode)).stopReason, 'end_turn');
  assert.equal(fixture.requests.length, 1, 'One Unicode prompt must cause exactly one initial HTTP request');
  assert.equal(userPromptCount(fixture.requests[0].body, fixture.prompts.unicode), 1);
  assert.equal(agentText(updates), fixture.expected.unicodeReply);
  assert.equal(permissions.length, 0);

  await gatedWrite(acp, fixture, updates, {
    prompt: fixture.prompts.allow, callId: ALLOW_CALL_ID,
    target: fixture.targets.allowed, content: fixture.expected.allowed,
    optionId: 'allow_once', finalText: fixture.expected.allowReply,
  });
  assert.equal(fixture.requests.length, 3);
  await gatedWrite(acp, fixture, updates, {
    prompt: fixture.prompts.reject, callId: REJECT_CALL_ID,
    target: fixture.targets.rejected, content: fixture.expected.rejected,
    optionId: 'reject_once', finalText: fixture.expected.rejectReply,
  });
  assert.equal(permissions.length, 2, 'The real runtime must gate both file operations');
  assert.match(JSON.stringify(updates), /user_denied/);
  fixture.assertComplete({ resumed: false });
  await exitThroughEof(acp);

  const sessionPath = join(fixture.home, '.fx', 'sessions', sessionId, 'session.json');
  const saved = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(saved.id, sessionId);
  assert.equal(saved.workspace_root, fixture.workspace);
  assert.ok(saved.history_len > 0, 'The real process must save nonempty conversation history');

  const resumed = createClient();
  const replay = [];
  resumed.on('update', update => replay.push(update));
  assert.equal(await resumed.start({ resume: sessionId }), sessionId);
  assert.notEqual(resumed.child.pid, acp.child.pid, 'Resume must occur in a new real fx process');
  assert.equal(fixture.requests.length, 5, 'Loading a saved session must not generate another provider request');
  assert.equal(replay.filter(update => update.sessionUpdate === 'user_message_chunk' && update.content?.text === fixture.prompts.unicode).length, 1);
  assert.ok(agentText(replay).includes(fixture.expected.unicodeReply));
  for (const [callId, status] of [[ALLOW_CALL_ID, 'completed'], [REJECT_CALL_ID, 'failed']]) {
    assert.ok(replay.some(update => update.sessionUpdate === 'tool_call' && update.toolCallId === callId && update.name === 'write_file'));
    assert.ok(replay.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === callId && update.status === status));
  }
  assert.equal(await readFile(fixture.targets.allowed, 'utf8'), fixture.expected.allowed);
  assert.equal(await readFile(fixture.targets.rejected, 'utf8'), fixture.expected.seed);

  const continued = [];
  resumed.on('update', update => continued.push(update));
  assert.equal((await resumed.prompt(fixture.prompts.resume)).stopReason, 'end_turn');
  assert.equal(agentText(continued), fixture.expected.resumeReply);
  fixture.assertComplete();
  await exitThroughEof(resumed);
  t.diagnostic(JSON.stringify({
    gate: 'real-fx-acp', provider: 'synthetic-loopback-only', binary: identity.binary, sha256: identity.sha256,
    sessionId, httpRequests: fixture.requests.length, unicodeInitialRequests: 1, permissions: ['allow_once', 'reject_once'],
    ownedFileWrite: true, rejectedFileUnchanged: true, persistedResume: true, eofExits: [0, 0],
  }));
});
