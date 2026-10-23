import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Draft, Projection, safeText } from '../model.mjs';

test('native edits honor UTF-16, stale length, and codepoint boundaries', () => {
  const draft = new Draft();
  assert.equal(draft.replace('A🙂B'), true);
  assert.equal(draft.edit({ from: 1, to: 3, text: '🥇', cursor: 3, len: 4 }), true);
  assert.equal(draft.text, 'A🥇B');
  assert.equal(draft.edit({ from: 2, to: 3, text: '', cursor: 2, len: 4 }), false);
  assert.equal(draft.edit({ from: 0, to: 0, text: 'stale', cursor: 5, len: 3 }), false);
  assert.equal(draft.undo(), true);
  assert.equal(draft.text, 'A🙂B');
  assert.equal(draft.send('stale'), null);
  assert.equal(draft.send('A🙂B'), 'A🙂B');
  assert.equal(draft.send('A🙂B'), null);
});

test('draft prevents oversized and nonsensical editor events', () => {
  const draft = new Draft();
  assert.equal(draft.replace('x'.repeat(32769)), false);
  assert.equal(draft.replace('ok'), true);
  assert.equal(draft.edit({ from: 0, to: 0, text: 'a'.repeat(32769), cursor: 1, len: 2 }), false);
  assert.equal(draft.edit({ from: -1, to: 0, text: 'a', cursor: 1, len: 2 }), false);
  assert.equal(draft.text, 'ok');
});

test('stream updates preserve message identity and remove unsafe control bytes', () => {
  const model = new Projection();
  model.beginPrompt('hello');
  model.update({ sessionUpdate: 'agent_message_chunk', messageId: 'z', content: { text: 'a' } });
  model.update({ sessionUpdate: 'agent_message_chunk', messageId: 'z', content: { text: '\u001b[31m中🙂' } });
  model.update({ sessionUpdate: 'tool_call', toolCallId: 't', name: 'shell', status: 'in_progress' });
  model.update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' });
  assert.equal(model.messages.filter(m => m.kind === 'assistant').length, 1);
  assert.equal(model.messages.find(m => m.kind === 'assistant').text, 'a�[31m中🙂');
  assert.equal(model.messages.find(m => m.kind === 'tool').status, 'completed');
  assert.equal(safeText('\u001b]52;c;bad\u0007'), '�]52;c;bad�');
  model.finishPrompt();
  assert.equal(model.busy, false);
});

test('native caret offsets cannot split a surrogate pair and malformed sends are rejected', () => {
  const draft = new Draft();
  assert.equal(draft.edit({ from: 0, to: 0, text: '🙂', cursor: 1, len: 0 }), false);
  assert.equal(draft.text, '');
  assert.equal(draft.edit({ from: 0, to: 0, text: '🙂', cursor: 2, len: 0 }), true);
  assert.equal(draft.cursor, 2);
  assert.equal(draft.edit({ from: 2, to: 2, text: '', cursor: 1, len: 2 }), false);
  assert.equal(draft.send(undefined), null);
  assert.equal(draft.send({ text: '🙂' }), null);
  assert.equal(draft.text, '🙂');
});
