import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExactFirstSend, composerWitnesses } from './fixtures/native-wire.mjs';

const expected = 'café 東京 🙂\nSecond line e\u0301';
const frame = ops => ({ dir: 'out', verb: 'f', body: { sf: 'fx', s: 1, ops } });
const add = text => frame([['add', 'dock', 'fx', null, { id: 'dock', k: 'col', c: [
  { id: 'dock.composer', k: 'editor', p: { text } },
] }]]);
const send = text => ({ dir: 'in', verb: 'e', body: { ev: 'send', sf: 'fx', id: 'dock.composer', text } });

test('native witness requires exact rendered and atomic Unicode values', () => {
  const records = [add('old draft'), frame([['text', 'dock.composer', 'replace', expected]]), send(expected),
    frame([['text', 'dock.composer', 'replace', '']])];
  assertExactFirstSend(records, expected);
  assert.deepEqual(composerWitnesses(records).sends, [{ composerText: expected, sendText: expected }]);
});

test('native witness rejects old draft contamination and mismatched send payloads', () => {
  assert.throws(() => assertExactFirstSend([add('old draft' + expected), send('old draft' + expected)], expected));
  assert.throws(() => assertExactFirstSend([add(expected), send(expected + 'old draft')], expected));
  assert.throws(() => assertExactFirstSend([add(expected)], expected));
});

test('native witness tracks appends and does not reuse removed composer state', () => {
  assertExactFirstSend([add(''), frame([['text', 'dock.composer', 'append', expected]]), send(expected)], expected);
  assert.throws(() => assertExactFirstSend([add(expected), frame([['del', 'dock']]), send(expected)], expected));
});
