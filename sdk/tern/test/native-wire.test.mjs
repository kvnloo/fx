import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeJson } from '@stencil-hq/tern';
import { assertExactSends, assertNoRuntimeError, composerWitnesses, decodeRawMessages, validateNativeWire } from './fixtures/native-wire.mjs';

const expected = 'café 東京 🙂\nSecond line e\u0301';
const frame = ops => ({ dir: 'out', verb: 'f', body: { sf: 'fx', s: 1, ops } });
const add = text => frame([['add', 'dock', 'fx', null, { id: 'dock', k: 'col', c: [
  { id: 'dock.composer', k: 'editor', p: { text } },
] }]]);
const send = text => ({ dir: 'in', verb: 'e', body: { ev: 'send', sf: 'fx', id: 'dock.composer', text } });

test('native witness requires exact rendered and atomic Unicode values', () => {
  const records = [add('old draft'), frame([['text', 'dock.composer', 'replace', expected]]), send(expected),
    frame([['text', 'dock.composer', 'replace', '']])];
  assertExactSends(records, [expected]);
  assert.deepEqual(composerWitnesses(records).sends, [{ composerText: expected, sendText: expected }]);
});

test('native witness rejects old draft contamination and mismatched send payloads', () => {
  assert.throws(() => assertExactSends([add('old draft' + expected), send('old draft' + expected)], [expected]));
  assert.throws(() => assertExactSends([add(expected), send(expected + 'old draft')], [expected]));
  assert.throws(() => assertExactSends([add(expected)], [expected]));
});

test('native witness tracks appends and does not reuse removed composer state', () => {
  assertExactSends([add(''), frame([['text', 'dock.composer', 'append', expected]]), send(expected)], [expected]);
  assert.throws(() => assertExactSends([add(expected), frame([['del', 'dock']]), send(expected)], [expected]));
});

test('native witness rejects any extra, reordered, or mismatched later send', () => {
  const second = 'Second exact request';
  const records = [add(expected), send(expected), frame([['text', 'dock.composer', 'replace', second]]), send(second)];
  assertExactSends(records, [expected, second]);
  assert.throws(() => assertExactSends([...records, send(second)], [expected, second]));
  assert.throws(() => assertExactSends(records, [second, expected]));
  assert.throws(() => assertExactSends([...records.slice(0, -1), send(second + ' contamination')], [expected, second]));
});

const record = (dir, verb, body) => ({ dir, verb, params: {}, body });
const out = (verb, body) => record('out', verb, body);
const ack = s => record('in', 'e', { ev: 'ack', sf: 'fx', s });
const nextFrame = s => out('f', { sf: 'fx', s, ops: [['focus', 'dock.composer']] });
const finish = () => out('x', { id: 'fx', keep: true });
function startWire() {
  return [
    out('q', { q: 'hello', v: [1], app: 'fx', features: ['edit', 'undo', 'send'] }),
    record('in', 'r', { r: 'hello', v: 1, term: 'tern', ver: '0.9.5', credits: 2, apc: 65536 }),
    out('o', { id: 'fx', mode: 'inline' }),
  ];
}
const rawWire = records => Buffer.concat(records.filter(row => row.dir === 'out').map(row => Buffer.from(encodeJson(row))));

test('wire ledger binds authentic ACKs and final close to actual producer bytes', () => {
  const records = [...startWire(), nextFrame(1), ack(1), nextFrame(2), ack(2), finish()];
  assert.deepEqual(validateNativeWire(records, rawWire(records)),
    { frames: 2, lastSent: 2, lastAck: 2, credits: 2, opens: 1, closed: true });
});

test('wire ledger rejects repeated or skipped frames, invented and backward ACKs', () => {
  for (const middle of [
    [nextFrame(1), ack(1), nextFrame(1)],
    [nextFrame(2)],
    [nextFrame(1), ack(2)],
    [nextFrame(1), ack(1), nextFrame(2), ack(2), ack(1)],
    [nextFrame(1), nextFrame(2), nextFrame(3)],
  ]) {
    const records = [...startWire(), ...middle, finish()];
    assert.throws(() => validateNativeWire(records, rawWire(records)));
  }
});

test('wire ledger rejects unacknowledged close, missing lifecycle, and traffic after close', () => {
  for (const records of [
    [...startWire(), nextFrame(1), finish()],
    [...startWire(), nextFrame(1), ack(1)],
    [...startWire(), nextFrame(1), ack(1), finish(), finish()],
    [...startWire(), nextFrame(1), ack(1), finish(), nextFrame(2)],
  ]) assert.throws(() => validateNativeWire(records, rawWire(records)));
});

test('raw reconciliation rejects omitted, extra, truncated, and malformed producer packets', () => {
  const records = [...startWire(), nextFrame(1), ack(1), finish()];
  const raw = rawWire(records);
  assert.throws(() => validateNativeWire(records, rawWire(records.slice(0, -1))));
  assert.throws(() => validateNativeWire(records, Buffer.concat([raw, Buffer.from(encodeJson(nextFrame(2)))])));
  assert.throws(() => validateNativeWire(records, raw.subarray(0, -1)));
  assert.throws(() => decodeRawMessages(Buffer.concat([raw, Buffer.from('\x1b_tsp')])));
  assert.throws(() => decodeRawMessages(Buffer.from('\x1b_tsp;f;not-json\x1b\\')));
});

test('raw decoder reconstructs actual SDK UTF-8 chunk groups and rejects incomplete groups', () => {
  const message = { verb: 'f', body: { sf: 'fx', s: 1, ops: [['text', 'main.body', 'replace', '東京🙂'.repeat(100)]] } };
  const bytes = Buffer.from(encodeJson(message, { limit: 128, chunk: () => 'owned-chunk' }));
  assert.deepEqual(decodeRawMessages(bytes, 128), [{ ...message, params: {} }]);
  const last = bytes.lastIndexOf(Buffer.from('\x1b_tsp;'));
  assert.throws(() => decodeRawMessages(bytes.subarray(0, last), 128));
});

test('runtime-error witnesses reject failures even when a Ready editor is present', () => {
  const errorFrame = frame([['add', 'main', 'fx', null, { id: 'main', k: 'col', c: [
    { id: 'main.error', k: 'text', p: { text: 'Real request failed' } },
  ] }]]);
  assert.throws(() => assertNoRuntimeError([add(expected), errorFrame]));
  assert.throws(() => assertNoRuntimeError([record('in', 'e', { ev: 'error', message: 'invalid frame' })]));
});
