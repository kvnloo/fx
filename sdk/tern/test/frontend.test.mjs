import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FxTernFrontend } from '../frontend.mjs';
import { Session, Surface, encodeJson, ui as nativeUi, html as nativeHtml } from '@stencil-hq/tern';
import { PassThrough } from 'node:stream';

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
  const events = [];
  const session = {
    closed: false, opens: [], surface: null,
    open(options) {
      this.opens.push(options);
      this.surface = { id: options.id, closed: false, view: null, renders: 0, focused: null,
        focus(id) { this.focused = id; }, gone() { this.closed = true; }, render(view) { this.view = view; this.renders++; } };
      return this.surface;
    },
    emit(event) {
      if (event.type === 'event' && event.event.ev === 'gone' && event.event.ids.includes(this.surface.id)) this.surface.closed = true;
      events.push(event); unblock?.();
    },
    async close() { this.closed = true; unblock?.(); },
    async *[Symbol.asyncIterator]() {
      while (!this.closed) {
        if (events.length) yield events.shift();
        else await new Promise(resolve => { unblock = resolve; });
      }
    },
  };
  return { ui, html: ui, encodeJson, session, connect: async () => session };
}

test('native Tern editor drives FX ACP, streaming, explicit approval and clean close', async () => {
  const sdk = fakeSdk();
  const acp = new FakeAcp();
  const input = { isTTY: true }; const output = { isTTY: true, write() {} };
  const front = new FxTernFrontend({ acp, sdk, input, output });
  const running = front.run();
  try {
    await waitFor(() => Boolean(sdk.session.surface?.view));
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
    await waitFor(() => Boolean(sdk.session.surface?.view));
    front.state.draft.replace('running');
    assert.equal(front.send('running'), true);
    await front.handleKey({ name: 'c', ctrl: true });
    assert.equal(acp.cancellations, 1);
    acp.finish({ stopReason: 'cancelled' });
  } finally { await front.stop(); await running; }
});

test('gone only retires its listed surface; adoption preserves the FX session and draft', async () => {
  const sdk = fakeSdk(); const acp = new FakeAcp();
  const front = new FxTernFrontend({ acp, sdk, input: { isTTY: true }, output: { isTTY: true, write() {} } });
  const running = front.run();
  try {
    await waitFor(() => sdk.session.surface?.view);
    front.handleEdit({ from: 0, to: 0, text: 'draft🙂', cursor: 7, len: 0 });
    sdk.session.emit({ type: 'event', event: { ev: 'gone', ids: ['main.tool'] } });
    await delay(10);
    assert.equal(sdk.session.opens.length, 1);
    sdk.session.emit({ type: 'event', event: { ev: 'gone', ids: ['fx'] } });
    await waitFor(() => sdk.session.opens.length === 2);
    assert.equal(sdk.session.opens[1].adopt, true);
    assert.equal(sdk.session.surface.focused, 'dock.composer');
    assert.equal(front.state.draft.text, 'draft🙂');
    assert.equal(front.state.sessionId, 'session-1');
    assert.equal(acp.closed, false);
  } finally { await front.stop(); await running; }
});

test('stale permission callbacks cannot approve a replacement and cancellation removes its UI', async () => {
  const sdk = fakeSdk(); const acp = new FakeAcp();
  const front = new FxTernFrontend({ acp, sdk, input: { isTTY: true }, output: { isTTY: true, write() {} } });
  const running = front.run();
  try {
    await waitFor(() => sdk.session.surface?.view);
    const permission = id => ({ id, options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }] });
    acp.emit('permission', permission(1));
    const stale = find(sdk.session.surface.view.dock, 'button').props.onClick;
    acp.emit('permission', permission(2));
    assert.equal(front.respondPermission('allow_once'), true);
    stale();
    assert.deepEqual(acp.responses, [[1, 'allow_once']]);
    acp.emit('permission_cancelled', 2);
    assert.equal(front.state.pendingPermission, null);
    assert.equal(find(sdk.session.surface.view.dock, 'button'), undefined);
  } finally { await front.stop(); await running; }
});

test('the pinned SDK reconciles the exact focus target and dispatches native editor events', async () => {
  const acp = new FakeAcp(); const frames = [];
  const surface = new Surface({ send: frame => frames.push(frame), credits: () => 100, dropped() {} }, 'fx', {});
  const front = new FxTernFrontend({ acp, sdk: { ui: nativeUi, html: nativeHtml, encodeJson }, input: {}, output: { write() {} } });
  front.surface = surface;
  front.render();
  surface.focus('dock.composer');
  assert.ok(frames.some(frame => frame.body.ops.some(op => op[0] === 'focus' && op[1] === 'dock.composer')));
  const edit = { ev: 'edit', sf: 'fx', id: 'dock.composer', from: 0, to: 0, text: 'hi🙂', cursor: 4, len: 0, raw: {} };
  assert.ok(surface.dispatch(edit));
  surface.dispatch(edit)();
  assert.equal(front.state.draft.text, 'hi🙂');
  surface.dispatch({ ev: 'undo', sf: 'fx', id: 'dock.composer', raw: {} })();
  assert.equal(front.state.draft.text, '');
  surface.dispatch(edit)();
  surface.dispatch({ ev: 'send', sf: 'fx', id: 'dock.composer', text: 'hi🙂', raw: {} })();
  assert.deepEqual(acp.prompts, ['hi🙂']);
  acp.finish();
  await front.stop();
});

test('unsupported SDK negotiation falls back to plain input, while connect failures propagate', async () => {
  const input = new PassThrough(); input.isTTY = true;
  let printed = '';
  const output = { isTTY: true, write(text) { printed += text; } };
  const acp = new FakeAcp();
  const front = new FxTernFrontend({ acp, sdk: { connect: async () => null }, input, output });
  const running = front.run();
  await waitFor(() => front.lines);
  input.end('/quit\n');
  await running;
  assert.match(printed, /FX ACP session session-1/);
  const failed = new FakeAcp();
  await assert.rejects(new FxTernFrontend({ acp: failed, sdk: { connect: async () => { throw new Error('tty owned'); } },
    input: { isTTY: true }, output }).run(), /tty owned/);
  assert.equal(failed.closed, true);
});

test('concurrent stop callers await terminal restoration and ACP cleanup even on failure', async () => {
  const acp = new FakeAcp(); let restore;
  const front = new FxTernFrontend({ acp, input: {}, output: {} });
  front.terminal = { close: () => new Promise((_, reject) => { restore = () => reject(new Error('output closed')); }) };
  const first = front.stop(); const second = front.stop();
  assert.equal(first, second);
  assert.equal(acp.closed, false);
  restore();
  await assert.rejects(first, /output closed/);
  assert.equal(acp.closed, true);
});

test('a late connection is closed before a stop during negotiation resolves', async () => {
  const acp = new FakeAcp(); const sdk = fakeSdk(); let connected;
  sdk.connect = () => new Promise(resolve => { connected = resolve; });
  const front = new FxTernFrontend({ acp, sdk, input: { isTTY: true }, output: { isTTY: true } });
  const running = front.run();
  await waitFor(() => connected);
  const stopping = front.stop();
  connected(sdk.session);
  await stopping; await running;
  assert.equal(sdk.session.closed, true);
  assert.equal(sdk.session.opens.length, 0);
  assert.equal(acp.closed, true);
});

test('real SDK rejects both old permission IDs and callbacks bound before replacement', async () => {
  const acp = new FakeAcp(); const sdk = fakeSdk();
  sdk.ui = nativeUi; sdk.html = nativeHtml;
  sdk.session.open = options => {
    sdk.session.surface = new Surface({ send() {}, credits: () => 100, dropped() {} }, options.id, options);
    return sdk.session.surface;
  };
  const front = new FxTernFrontend({ acp, sdk, input: { isTTY: true }, output: { isTTY: true, write() {} } });
  const running = front.run();
  try {
    await waitFor(() => front.surface);
    const options = [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }];
    acp.emit('permission', { id: 1, options });
    const oldEvent = { ev: 'action', sf: 'fx', id: 'dock.permission-1.choices.p0', act: 'click', raw: {} };
    const bound = front.surface.dispatch(oldEvent);
    assert.equal(typeof bound, 'function');
    acp.emit('permission', { id: 2, options });
    front.respondPermission('allow_once');
    assert.equal(front.surface.dispatch(oldEvent), undefined);
    bound();
    assert.deepEqual(acp.responses, [[1, 'allow_once']]);
    front.surface.dispatch({ ...oldEvent, id: 'dock.permission-2.choices.p0' })();
    assert.deepEqual(acp.responses, [[1, 'allow_once'], [2, 'allow_once']]);
  } finally { await front.stop(); await running; }
});

test('real SDK shutdown retires unsent frames without exceeding credits and restores owned input', async () => {
  const input = new EventEmitter();
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  input.resume = () => {}; input.pause = () => {};
  const writes = [];
  const output = { isTTY: true, write(bytes) {
    const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString();
    writes.push(text);
    if (text.includes('"q":"hello"')) queueMicrotask(() => input.emit('data', encodeJson({
      verb: 'r', body: { r: 'hello', v: 1, term: 'test', credits: 1 },
    })));
  } };
  const sdk = { ui: nativeUi, html: nativeHtml, encodeJson, async connect(options) {
    const session = new Session(input, output, options);
    return await session.handshake() ? session : null;
  } };
  const acp = new FakeAcp();
  const front = new FxTernFrontend({ acp, sdk, input, output });
  const running = front.run();
  try {
    await waitFor(() => front.surface);
    assert.equal(input.isRaw, true);
    front.handleEdit({ from: 0, to: 0, text: 'unsent', cursor: 6, len: 0 });
    assert.equal(front.surface.blocked, true);
    const stopping = front.stop();
    // A terminal ACK for the actual first frame cannot pump a retired surface.
    input.emit('data', encodeJson({ verb: 'e', body: { ev: 'ack', sf: 'fx', s: 1 } }));
    await stopping; await running;
    assert.equal(writes.filter(text => text.startsWith('\x1b_tsp;f;')).length, 1);
    assert.equal(writes.filter(text => text.startsWith('\x1b_tsp;x;')).length, 1);
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(acp.closed, true);
  } finally { await front.stop(); await running; }
});

for (const outcome of [
  { code: 0, signal: null, stderr: '' },
  { code: 17, signal: null, stderr: 'native failure' },
  { code: null, signal: 'SIGTERM', stderr: '' },
]) {
  test(`run exposes actual FX shutdown outcome ${JSON.stringify(outcome)}`, async () => {
    const sdk = fakeSdk();
    const acp = new FakeAcp();
    acp.close = async () => { acp.closed = true; return outcome; };
    const front = new FxTernFrontend({ acp, sdk, input: { isTTY: true }, output: { isTTY: true, write() {} } });
    const running = front.run();
    const result = outcome.code === 0
      ? running
      : assert.rejects(running, error => error.outcome === outcome && /fx acp exited/.test(error.message));
    await waitFor(() => front.surface);
    await sdk.session.close();
    await result;
    assert.equal(front.outcome, outcome);
    assert.equal(acp.closed, true);
  });
}

test('run does not hide genuine transport failure during initiated shutdown', async () => {
  const sdk = fakeSdk();
  const acp = new FakeAcp();
  const failure = new Error('broken stdin');
  acp.close = async () => {
    acp.failure = failure;
    return { code: 0, signal: null, stderr: '' };
  };
  const front = new FxTernFrontend({ acp, sdk, input: { isTTY: true }, output: { isTTY: true, write() {} } });
  const running = front.run();
  const rejected = assert.rejects(running, error => error === failure);
  await waitFor(() => front.surface);
  await sdk.session.close();
  await rejected;
});
