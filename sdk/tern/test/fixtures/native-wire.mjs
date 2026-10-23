import assert from 'node:assert/strict';

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

export function assertExactFirstSend(records, expected) {
  const { sends } = composerWitnesses(records);
  assert.ok(sends.length > 0, 'Actual Tern must emit a native send event');
  assert.equal(sends[0].composerText, expected, 'Rendered draft before send must match exactly');
  assert.equal(sends[0].sendText, expected, 'Native send text must match exactly');
}
