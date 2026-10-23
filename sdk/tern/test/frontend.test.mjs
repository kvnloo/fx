import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FxTernFrontend } from '../frontend.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(10); } throw new Error('Timed out'); }
const builder = kind => (...args) => ({ kind, props: args[0] && !Array.isArray(args[0]) && typeof args[0] === 'object' ? args[0] : {}, children: args.slice(1) });
const ui = new Proxy({}, { get: (_, key) => builder(String(key)) });
const find = (node, kind) => node?.kind === kind ? node : (node?.children ?? []).map(item => find(item, kind)).find(Boolean);

class FakeAcp extends EventEmitter {
  constructor() { super(); this.prompts = []; this.responses = []; this.cancellations = 0; this.closed = false; }
  async start() { return 'session-1'; }
  prompt(text) { this.prompts.push(text); return new Promise(resolve => { this.finish = resolve; }); }
  respondPermission(id, optionId) { this.responses.push([id, optionId]); return true; }
  async cancel() { this.cancellations++; }
  async close() { this.closed = true; }
}

function fakeSdk() {
  let unblock;
  const session = {
    closed: false,
    open() { return this.surface; },
    surface: { view: null, renders: 0, focus() {}, render(view) { this.view = view; this.renders++; } },
    async close() { this.closed = true; unblock?.(); },
    async *[Symbol.asyncIterator]() { while (!this.closed) await new Promise(resolve => { unblock = resolve; }); },
  };
  return { ui, html: ui, session, connect: async () => session };
}

test('native Tern editor drives FX ACP, streaming, explicit approval and clean close', async () => {
  const sdk = fakeSdk();
  const acp = new FakeAcp();
  const input = { isTTY: true }; const output = { isTTY: true, write() {} };
  const front = new FxTernFrontend({ acp, sdk, input, output });
  const running = front.run();
  try {
    await waitFor(() => Boolean(sdk.session.surface.view));
    let editor = find(sdk.session.surface.view.dock, 'editor');
    assert.equal(editor.props.onEdit({ from: 0, to: 0, text: 'hi🙂', cursor: 4, len: 0 }), true);
    editor = find(sdk.session.surface.view.dock, 'editor');
    assert.equal(editor.props.onSend({ text: 'stale' }), false);
    assert.equal(editor.props.onSend({ text: 'hi🙂' }), true);
    assert.deepEqual(acp.prompts, ['hi🙂']);
    assert.equal(editor.props.onSend({ text: 'hi🙂' }), false);
    acp.emit('update', { sessionUpdate: 'agent_message_chunk', messageId: 'agent:1', content: { text: 'reply' } });
    acp.emit('permission', { id: 44, toolCall: { title: 'Write', rawInput: { path: '/tmp/test' } }, options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ] });
    assert.ok(find(sdk.session.surface.view.dock, 'button'));
    await front.handleKey({ name: '2', ctrl: false });
    assert.deepEqual(acp.responses, [[44, 'reject_once']]);
    acp.finish({ stopReason: 'end_turn' });
    await waitFor(() => front.state.busy === false);
    assert.equal(front.state.messages.find(x => x.kind === 'assistant').text, 'reply');
  } finally { await front.stop(); await running; }
  assert.equal(acp.closed, true);
  assert.equal(sdk.session.closed, true);
});

test('Ctrl+C cancels an active FX prompt, not tool permission or session ownership', async () => {
  const sdk = fakeSdk(); const acp = new FakeAcp();
  const front = new FxTernFrontend({ acp, sdk, input: { isTTY: true }, output: { isTTY: true, write() {} } });
  const running = front.run();
  try {
    await waitFor(() => Boolean(sdk.session.surface.view));
    front.state.draft.replace('running');
    assert.equal(front.send('running'), true);
    await front.handleKey({ name: 'c', ctrl: true });
    assert.equal(acp.cancellations, 1);
    acp.finish({ stopReason: 'cancelled' });
  } finally { await front.stop(); await running; }
});
