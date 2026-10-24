/** Deterministic ACP subprocess with permission gating and streamed output. */
let active = 'test-session';
let permissionId = null;
let promptId = null;
let buffer = '';
function send(data) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    if (req.method === 'initialize') send({ id: req.id, result: { protocolVersion: 1 } });
    else if (req.method === 'session/new' || req.method === 'session/load') {
      if (req.method === 'session/load') active = req.params.sessionId;
      send({ id: req.id, result: { sessionId: active } });
      send({ method: 'session/update', params: { sessionId: active, update: { sessionUpdate: 'session_info_update', title: 'Fixture' } } });
    } else if (req.method === 'session/prompt') {
      promptId = req.id;
      send({ method: 'session/update', params: { sessionId: active, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello ' } } } });
      permissionId = 900;
      send({ id: permissionId, method: 'session/request_permission', params: { sessionId: active, toolCall: { toolCallId: 't1', name: 'write_file', title: 'Write fixture' }, options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ] } });
    } else if (req.id === permissionId && req.result?.outcome?.outcome === 'selected') {
      const choice = req.result.outcome.optionId;
      send({ method: 'session/update', params: { sessionId: active, update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: choice === 'allow_once' ? 'completed' : 'failed' } } });
      send({ method: 'session/update', params: { sessionId: active, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'world \u001b[2J🙂' } } } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      permissionId = null; promptId = null;
    } else if (req.method === 'session/cancel') {
      send({ id: req.id, result: {} });
      if (promptId !== null) send({ id: promptId, result: { stopReason: 'cancelled' } });
      promptId = null;
    } else if (req.id !== undefined && req.method) send({ id: req.id, error: { code: -32601, message: 'Unknown method' } });
  }
});
