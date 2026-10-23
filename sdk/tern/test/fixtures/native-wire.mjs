import assert from 'node:assert/strict';
import { splitMessage, MAX_INPUT_MESSAGE } from '@stencil-hq/tern';

/** Replays only the authoritative composer fields from real SDK frame records. */
export function composerWitnesses(records, id = 'dock.composer') {
  let text;
  const sends = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.id === id) text = node.p?.text ?? '';
    for (const child of node.c ?? []) visit(child);
  }
  for (const record of records) {
    if (record.dir === 'out' && record.verb === 'f') {
      for (const op of record.body.ops) {
        if (op[0] === 'add') visit(op[4]);
        else if (op[0] === 'del' && (op[1] === 'dock' || op[1] === id)) text = undefined;
        else if (op[0] === 'set' && op[1] === id && Object.hasOwn(op[2], 'text')) text = op[2].text;
        else if (op[0] === 'text' && op[1] === id) {
          assert.equal(typeof text, 'string', 'Composer text operation requires a rendered composer');
          assert.ok(['append', 'replace'].includes(op[2]), 'Unknown composer text operation');
          text = op[2] === 'append' ? text + op[3] : op[3];
        }
      }
    } else if (record.dir === 'in' && record.body.ev === 'send' && record.body.id === id) {
      sends.push({ composerText: text, sendText: record.body.text });
    }
  }
  return { text, sends };
}

export function assertExactSends(records, expected) {
  const { sends } = composerWitnesses(records);
  assert.deepEqual(sends.map(send => send.composerText), expected, 'Every rendered draft must match the intended sequence exactly');
  assert.deepEqual(sends.map(send => send.sendText), expected, 'Native sends must match the complete intended sequence exactly');
}

/** Decodes the actual stdout APC bytes, including complete SDK chunk groups. */
export function decodeRawMessages(raw, limit = 65536) {
  const bytes = Buffer.from(raw);
  const start = Buffer.from('\x1b_tsp;');
  const anyApc = Buffer.from('\x1b_');
  const end = Buffer.from('\x1b\\');
  const pending = new Map();
  const messages = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  while ((offset = bytes.indexOf(anyApc, offset)) !== -1) {
    assert.ok(bytes.subarray(offset, offset + start.length).equals(start), 'Unexpected or truncated raw APC prefix');
    const stop = bytes.indexOf(end, offset + start.length);
    assert.ok(stop !== -1, 'Truncated raw TSP packet');
    const packet = splitMessage(bytes.subarray(offset + start.length, stop));
    assert.ok(packet && /^[qofx]$/.test(packet.verb), 'Unexpected raw producer verb');
    assert.ok(packet.body.length <= limit, 'Raw packet exceeds negotiated APC limit');
    const params = Object.fromEntries(packet.params);
    assert.equal(Object.keys(params).length, packet.params.length, 'Duplicate raw packet parameter');
    assert.ok(params.m === undefined || (params.c && params.m === '1'), 'Invalid chunk continuation');
    let body = packet.body;
    let originalParams = params;
    if (params.c !== undefined) {
      assert.ok(params.c.length > 0, 'Chunk identity must not be empty');
      const key = `${packet.verb}:${params.c}`;
      let group = pending.get(key);
      if (!group) {
        originalParams = { ...params };
        delete originalParams.c;
        delete originalParams.m;
        group = { parts: [], size: 0, params: originalParams };
        pending.set(key, group);
      } else assert.ok(Object.keys(params).every(key => key === 'c' || key === 'm'), 'Continuation changed packet parameters');
      group.parts.push(body);
      group.size += body.length;
      assert.ok(group.size <= MAX_INPUT_MESSAGE, 'Raw logical message is too large');
      if (params.m === '1') { offset = stop + end.length; continue; }
      body = Buffer.concat(group.parts);
      originalParams = group.params;
      pending.delete(key);
    }
    const value = JSON.parse(decoder.decode(body));
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'TSP body must be an object');
    messages.push({ verb: packet.verb, params: originalParams, body: value });
    offset = stop + end.length;
  }
  assert.equal(pending.size, 0, 'Incomplete raw chunk group');
  return messages;
}

export function assertNoRuntimeError(records) {
  function visit(node) {
    assert.notEqual(node?.id, 'main.error', 'The native app rendered a runtime error');
    for (const child of node?.c ?? []) visit(child);
  }
  for (const record of records) {
    if (record.dir === 'out' && record.verb === 'f') for (const op of record.body.ops) {
      if (op[0] === 'add') visit(op[4]);
      else if (op[0] === 'set') assert.notEqual(op[1], 'main.error', 'The native app updated a runtime error');
    }
    if (record.dir === 'in' && record.verb === 'e') assert.notEqual(record.body.ev, 'error', 'Tern reported a protocol error');
  }
}

/** Checks authentic frame/ACK credit and lifecycle facts, then reconciles stdout. */
export function validateNativeWire(records, raw, surface = 'fx') {
  let hello;
  let queried = false;
  let open = false;
  let gone = false;
  let closed = false;
  let opens = 0;
  let lastSent = 0;
  let lastAck = 0;
  let creditFloor = 0;
  const sent = new Set();
  const output = [];
  for (const record of records) {
    assert.ok(['in', 'out'].includes(record.dir));
    assert.ok(record.body && typeof record.body === 'object' && !Array.isArray(record.body));
    const body = record.body;
    if (record.dir === 'out') {
      assert.equal(closed, false, 'TSP producer traffic followed the final close');
      assert.ok(['q', 'o', 'f', 'x'].includes(record.verb));
      output.push({ verb: record.verb, params: record.params ?? {}, body });
      if (record.verb === 'q') {
        assert.equal(queried, false, 'Duplicate handshake');
        assert.equal(body.q, 'hello');
        assert.equal(body.app, 'fx');
        assert.ok(Array.isArray(body.v) && body.v.includes(1));
        assert.ok(['edit', 'undo', 'send'].every(feature => body.features?.includes(feature)));
        queried = true;
      } else if (record.verb === 'o') {
        assert.ok(hello && !open && body.id === surface && body.mode === 'inline');
        if (opens) {
          assert.ok(gone && body.adopt === true, 'Surface reopened without authentic retirement/adoption');
          creditFloor = lastSent;
        }
        open = true;
        gone = false;
        opens++;
      } else if (record.verb === 'f') {
        assert.ok(open && body.sf === surface);
        assert.ok(Number.isSafeInteger(body.s) && body.s === lastSent + 1, 'Frame sequence must advance exactly once');
        assert.ok(Array.isArray(body.ops) && body.ops.length > 0 && body.ops.every(op => Array.isArray(op) && typeof op[0] === 'string'));
        lastSent = body.s;
        sent.add(body.s);
        assert.ok(lastSent - Math.max(lastAck, creditFloor) <= hello.credits, 'Frame exceeded authentic negotiated credits');
      } else {
        assert.ok(open && body.id === surface && body.keep === true, 'Invalid final surface close');
        assert.equal(lastAck, lastSent, 'Sent frames remain unacknowledged at final close');
        open = false;
        closed = true;
      }
    } else if (record.verb === 'r') {
      assert.ok(queried && !hello && body.r === 'hello' && body.v === 1);
      assert.equal(body.term, 'tern');
      assert.equal(body.ver, '0.9.5');
      assert.ok(Number.isSafeInteger(body.credits) && body.credits > 0);
      assert.ok(Number.isSafeInteger(body.apc) && body.apc > 0);
      hello = body;
    } else {
      assert.equal(record.verb, 'e');
      assert.equal(typeof body.ev, 'string');
      assert.notEqual(body.ev, 'error', 'Tern reported a protocol error');
      if (body.ev === 'ack') {
        assert.equal(body.sf, surface);
        assert.ok(Number.isSafeInteger(body.s) && sent.has(body.s), 'ACK names a frame never sent');
        assert.ok(body.s >= lastAck, 'Cumulative ACK moved backwards');
        lastAck = body.s;
      } else if (body.ev === 'gone') {
        assert.ok(Array.isArray(body.ids) && body.ids.every(id => typeof id === 'string'));
        if (body.ids.includes(surface)) { assert.ok(open); open = false; gone = true; }
      } else if (body.ev === 'send' || body.ev === 'edit') {
        assert.ok(open && body.sf === surface && typeof body.id === 'string' && typeof body.text === 'string');
      }
    }
  }
  assert.ok(hello && opens > 0 && closed && !open, 'Native lifecycle did not reach an authenticated final close');
  assertNoRuntimeError(records);
  const decoded = decodeRawMessages(raw, hello.apc);
  assert.deepEqual(decoded, output, 'Recorded producer traffic differs from actual stdout APC bytes');
  return { frames: sent.size, lastSent, lastAck, credits: hello.credits, opens, closed };
}
