/** JSON-RPC 2.0 transport for fx acp. FX retains all agent/session authority. */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MAX_LINE = 2 * 1024 * 1024;
const STARTUP_TIMEOUT = 30_000;
const PROMPT_TIMEOUT = 15 * 60_000;

export class FxAcp extends EventEmitter {
  constructor({ binary = './zig-out/bin/fx', args = ['acp'], cwd = process.cwd(), env = process.env, spawnProcess = spawn } = {}) {
    super();
    this.binary = binary;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.spawnProcess = spawnProcess;
    this.nextId = 1;
    this.pending = new Map();
    this.permissions = new Map();
    this.buffer = '';
    this.stderr = '';
    this.sessionId = null;
    this.closed = false;
    this.child = null;
    this.activePrompt = null;
  }

  launch() {
    if (this.child || this.closed) throw new Error('ACP process cannot be launched again');
    const child = this.spawnProcess(this.binary, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#read(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4096); });
    child.on('error', err => this.#failed(err));
    child.on('exit', (code, signal) => this.#failed(new Error(`fx acp exited (${code ?? signal})${this.stderr ? ': ' + this.stderr : ''}`)));
  }

  #failed(err) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    this.permissions.clear();
    this.emit('failed', err);
  }

  #read(chunk) {
    this.buffer += chunk;
    while (true) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.#failed(new Error('Invalid ACP JSON')); this.child?.kill(); return; }
      if (Buffer.byteLength(line) > MAX_LINE) { this.#failed(new Error('ACP message exceeds 2 MiB')); this.child?.kill(); return; }
      this.#dispatch(message);
    }
    if (Buffer.byteLength(this.buffer) > MAX_LINE) { this.#failed(new Error('ACP message exceeds 2 MiB')); this.child?.kill(); }
  }

  #dispatch(message) {
    if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.id);
      if (message.error) p.reject(new Error(String(message.error.message ?? 'ACP request failed')));
      else p.resolve(message.result);
      return;
    }
    if (message.method === 'session/update') {
      if (!this.sessionId || message.params?.sessionId === this.sessionId) this.emit('update', message.params?.update);
      return;
    }
    if (message.id === undefined) return;
    if (message.method === 'session/request_permission' && Array.isArray(message.params?.options)) {
      this.permissions.set(message.id, message.params);
      this.emit('permission', { id: message.id, ...message.params });
      return;
    }
    // Unknown client methods must fail closed, not hang a running tool.
    this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported FX Tern client method' } });
  }

  #write(message) {
    if (this.closed || !this.child?.stdin.writable) throw new Error('FX ACP is unavailable');
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload) > MAX_LINE) throw new Error('ACP request exceeds 2 MiB');
    this.child.stdin.write(payload + '\n');
  }

  request(method, params = {}, timeout = STARTUP_TIMEOUT) {
    if (!this.child) this.launch();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#write({ jsonrpc: '2.0', id, method, params }); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  async start({ resume } = {}) {
    await this.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (resume) this.sessionId = resume;
    const result = resume
      ? await this.request('session/load', { sessionId: resume, cwd: this.cwd, mcpServers: [] })
      : await this.request('session/new', { cwd: this.cwd, mcpServers: [] });
    this.sessionId = resume ?? result?.sessionId;
    if (typeof this.sessionId !== 'string' || !this.sessionId) throw new Error('FX returned no session ID');
    return this.sessionId;
  }

  prompt(text) {
    if (!this.sessionId || this.activePrompt) throw new Error('No idle FX ACP session');
    const promise = this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, PROMPT_TIMEOUT);
    this.activePrompt = promise;
    void promise.finally(() => { if (this.activePrompt === promise) this.activePrompt = null; }).catch(() => {});
    return promise;
  }

  async cancel() {
    if (!this.sessionId) return;
    return this.request('session/cancel', { sessionId: this.sessionId }, 5000);
  }

  respondPermission(id, optionId) {
    const request = this.permissions.get(id);
    if (!request) return false;
    if (!request.options.some(option => option.optionId === optionId)) return false;
    this.permissions.delete(id);
    this.#write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } } });
    return true;
  }

  async close() {
    if (this.closed) return;
    for (const [id, value] of this.permissions) {
      const reject = value.options.find(option => option.kind === 'reject_once' || option.optionId === 'reject_once');
      if (reject) { try { this.respondPermission(id, reject.optionId); } catch {} }
    }
    const child = this.child;
    this.#failed(new Error('FX Tern session closed'));
    if (child && child.exitCode === null) {
      child.stdin.end();
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000);
      timer.unref();
    }
  }
}
