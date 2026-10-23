/** Synthetic loopback model responses. The client must run the real Zig fx ACP server. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SYNTHETIC_MODEL = 'tern-synthetic-model';
export const UNICODE_PROMPT = 'FX Tern Unicode boundary: café, 東京, 🙂\nSecond line: Ελληνικά\nThird line: e\u0301 stays decomposed.\n';
export const ALLOW_CALL_ID = 'tern_real_allow';
export const REJECT_CALL_ID = 'tern_real_reject';

export function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map(part => part.text ?? '').join('');
  return '';
}

export function userPromptCount(body, prompt) {
  return body.messages.filter(message => message.role === 'user').reduce((count, message) =>
    count + messageText(message).split(prompt).length - 1, 0);
}

function textChunks(text) {
  const parts = text.split('\n');
  return parts.map((part, index) => ({ choices: [{ index: 0, delta: {
    ...(index === 0 ? { role: 'assistant' } : {}), content: part + (index < parts.length - 1 ? '\n' : ''),
  }, finish_reason: null }] })).concat([
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 } },
  ]);
}

function toolChunks(id, path, content) {
  return [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path, content }) },
    }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

/** Creates only owned temporary files. env is a complete child environment, not an overlay. */
export async function startRealProvider({ withCancel = false, singleLine = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fx-tern-real-')));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const owned = join(root, 'owned-files');
  const requests = [];
  const failures = [];
  let closed = false;
  let resolveStarted;
  let resolveDisconnected;
  const cancellation = {
    started: false,
    disconnected: false,
    startedPromise: new Promise(resolve => { resolveStarted = resolve; }),
    disconnectedPromise: new Promise(resolve => { resolveDisconnected = resolve; }),
  };
  const targets = { allowed: join(owned, 'allowed.txt'), rejected: join(owned, 'rejected.txt') };
  const expected = {
    seed: 'Owned fixture seed. No tool ran yet.\n',
    allowed: 'Real fx wrote this after allow_once. 東京 🙂\nSecond written line.\n',
    rejected: 'This content must never reach the rejected file.\n',
    unicodeReply: singleLine
      ? 'Synthetic provider reply: café 東京 🙂. Single-line Unicode received once.'
      : 'Synthetic provider reply: café 東京 🙂\nMultiline received once.',
    allowReply: 'Synthetic provider observed the allowed tool result.',
    rejectReply: 'Synthetic provider observed user_denied.',
    cancelReply: 'Synthetic provider holds this running turn until cancellation.',
    resumeReply: 'Synthetic provider observed persisted history after process restart.',
  };
  const prompts = {
    unicode: UNICODE_PROMPT,
    allow: `Use write_file to overwrite this owned fixture file: ${targets.allowed}\nWait for my permission.`,
    reject: `Use write_file to overwrite this owned fixture file: ${targets.rejected}\nI will reject this operation.`,
    ...(withCancel ? { cancel: 'Start the held streaming fixture turn. I will cancel it before completion.' } : {}),
    resume: 'Resume the saved conversation. Preserve the earlier Unicode prompt and both tool results.',
  };
  if (singleLine) {
    for (const key of Object.keys(prompts)) prompts[key] = prompts[key].trimEnd().replaceAll('\n', ' | ');
  }
  const plan = [
    { prompt: prompts.unicode, chunks: () => textChunks(expected.unicodeReply) },
    { prompt: prompts.allow, chunks: () => toolChunks(ALLOW_CALL_ID, targets.allowed, expected.allowed), tool: true },
    { prompt: prompts.allow, chunks: () => textChunks(expected.allowReply), result: ALLOW_CALL_ID },
    { prompt: prompts.reject, chunks: () => toolChunks(REJECT_CALL_ID, targets.rejected, expected.rejected), tool: true },
    { prompt: prompts.reject, chunks: () => textChunks(expected.rejectReply), result: REJECT_CALL_ID },
    ...(withCancel ? [{ prompt: prompts.cancel, hold: true, chunks: () => [
      { choices: [{ index: 0, delta: { role: 'assistant', content: expected.cancelReply }, finish_reason: null }] },
    ] }] : []),
    { prompt: prompts.resume, resume: true, chunks: () => textChunks(expected.resumeReply) },
  ];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 2 * 1024 * 1024, 'Synthetic provider request exceeds 2 MiB');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry = { method: request.method, path: request.url, authorizationPresent: request.headers.authorization !== undefined, raw, body: JSON.parse(raw) };
      requests.push(entry);
      assert.equal(entry.method, 'POST');
      assert.equal(entry.path, '/v1/chat/completions', 'Only the loopback model endpoint is permitted');
      assert.equal(entry.authorizationPresent, false, 'Synthetic provider must receive no credential');
      const body = entry.body;
      assert.equal(body.model, SYNTHETIC_MODEL);
      assert.equal(body.stream, true);
      assert.ok(Array.isArray(body.messages));
      const step = plan[requests.length - 1];
      assert.ok(step, 'Unexpected extra HTTP request, retry, or duplicated prompt');
      const lastUser = body.messages.filter(message => message.role === 'user').at(-1);
      assert.ok(messageText(lastUser).includes(step.prompt), 'HTTP request must preserve the complete expected prompt');
      assert.equal(userPromptCount(body, prompts.unicode), 1, 'Unicode multiline prompt must occur once per conversation context');
      for (const prompt of Object.values(prompts)) {
        assert.ok(userPromptCount(body, prompt) <= 1, 'A user prompt must not be duplicated');
      }
      if (step.tool) {
        assert.ok(body.tools?.some(tool => tool.function?.name === 'write_file'), 'Real fx must advertise its file tool');
      }
      if (step.result) {
        const result = body.messages.filter(message => message.role === 'tool' && message.tool_call_id === step.result);
        assert.equal(result.length, 1, 'Real fx must return exactly one tool result');
        if (step.result === REJECT_CALL_ID) assert.match(messageText(result[0]), /user_denied/);
        else assert.doesNotMatch(messageText(result[0]), /user_denied|Not executed/);
      }
      if (step.resume) {
        for (const prompt of Object.values(prompts)) assert.equal(userPromptCount(body, prompt), 1);
        for (const id of [ALLOW_CALL_ID, REJECT_CALL_ID]) {
          assert.equal(body.messages.filter(message => message.role === 'tool' && message.tool_call_id === id).length, 1,
            'Resumed HTTP context must contain the persisted tool result');
        }
        assert.ok(body.messages.some(message => message.role === 'assistant' && messageText(message).includes(expected.unicodeReply)));
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      if (step.hold) {
        cancellation.started = true;
        response.once('close', () => {
          // Fixture cleanup is not evidence of cancellation by the real client.
          if (!closed && !response.writableEnded) {
            cancellation.disconnected = true;
            resolveDisconnected();
          }
        });
      }
      for (const chunk of step.chunks()) {
        response.write(`data: ${JSON.stringify({ id: `synthetic-${requests.length}`, object: 'chat.completion.chunk', model: SYNTHETIC_MODEL, ...chunk })}\n\n`);
      }
      if (step.hold) {
        response.flushHeaders();
        resolveStarted();
        return;
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: failures.at(-1) } }));
    }
  });
  try {
    await Promise.all([home, workspace, owned, join(home, '.fx')].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    await Promise.all(Object.values(targets).map(path => writeFile(path, expected.seed, { mode: 0o600 })));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const settings = {
      provider: 'tern-loopback',
      providers: {
        'tern-loopback': {
          protocol: 'openai-chat-completions', base_url: baseUrl, auth: { type: 'none' },
          model_metadata: { [SYNTHETIC_MODEL]: { context_window: 262144, max_output_tokens: 8192, supports_tool_use: true } },
        },
      },
      models: { 'tern-loopback': SYNTHETIC_MODEL },
      permission_mode: 'ask',
      permission: { edit: { [`${owned}/**`]: 'ask' } },
      auto_upgrade: false,
    };
    const settingsPath = join(home, '.fx', 'settings.json');
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    const env = {
      HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: root,
      LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1',
      FX_AUTO_UPGRADE: '0', FX_SOUND: '0', FX_PERMISSION_MODE: 'ask',
      FX_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/forbidden-gateway`,
      FX_GATEWAY_CHAT_URL: `http://127.0.0.1:${port}/forbidden-gateway`,
    };
    return {
      root, port, baseUrl, home, workspace, settings, settingsPath, env, requests, failures, prompts, targets, expected, cancellation,
      assertComplete({ resumed = true } = {}) {
        assert.deepEqual(failures, [], 'Synthetic provider rejected an unexpected HTTP request');
        assert.equal(requests.length, resumed ? plan.length : plan.length - 1, 'The real ACP gate must exercise every expected HTTP exchange');
        if (withCancel) {
          assert.equal(cancellation.started, true, 'The real cancellation gate must start a streaming model request');
          assert.equal(cancellation.disconnected, true, 'The real client must disconnect the held HTTP stream before fixture cleanup');
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
