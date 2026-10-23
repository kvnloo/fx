import { createInterface } from 'node:readline';
import { Projection, safeText } from './model.mjs';

/** Tern owns layout and input. FX ACP owns every operation and decision. */
export class FxTernFrontend {
  constructor({ acp, sdk, input = process.stdin, output = process.stdout }) {
    this.acp = acp;
    this.sdk = sdk;
    this.input = input;
    this.output = output;
    this.state = new Projection();
    this.permissionQueue = [];
    this.permissionSerial = 0;
    this.terminal = null;
    this.surface = null;
    this.lines = null;
    this.stopping = false;
    this.turn = null;
    this.closing = null;
    this.connecting = null;
  }

  async run({ resume } = {}) {
    let failure;
    const onUpdate = update => this.#onUpdate(update);
    const onPermission = request => this.#onPermission(request);
    const onCancelled = id => {
      this.permissionQueue = this.permissionQueue.filter(request => request.id !== id);
      this.state.pendingPermission = this.permissionQueue[0] ?? null;
      if (this.lines) {
        if (this.state.pendingPermission) this.#showPlainPermission();
        else { this.lines.setPrompt('fx> '); this.lines.prompt(); }
      }
      this.render();
    };
    const onFailed = err => {
      if (this.stopping) return;
      this.state.finishPrompt(err);
      failure = err;
      this.render();
      void this.stop().catch(() => {});
    };
    const onEnd = () => { void this.stop().catch(() => {}); };
    const signals = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((name, index) => [name, () => {
      process.exitCode = [130, 143, 129][index];
      void this.stop().catch(() => {});
    }]));
    this.acp.on('update', onUpdate);
    this.acp.on('permission', onPermission);
    this.acp.on('permission_cancelled', onCancelled);
    this.acp.on('failed', onFailed);
    this.input.once?.('end', onEnd);
    for (const [name, handler] of signals) process.on(name, handler);
    try {
      this.state.sessionId = await this.acp.start({ resume });
      if (this.stopping) return;
      if (this.sdk && this.input.isTTY && this.output.isTTY) {
        this.connecting = this.sdk.connect({
          app: 'fx', version: '0.1.0', features: ['edit', 'undo', 'send'],
          input: this.input, output: this.output, exitHooks: false,
        });
        // Null means unsupported; exceptions are real I/O or ownership failures.
        this.terminal = await this.connecting;
        if (this.stopping) return;
      }
      if (this.terminal) {
        this.#openSurface();
        for await (const event of this.terminal) {
          if (this.stopping) break;
          if (event.type === 'key') await this.handleKey(event.key);
          if (event.type === 'event' && event.event.ev === 'gone'
            && event.event.ids.includes(this.surface.id) && this.surface.closed) this.#openSurface(true);
        }
      } else {
        await this.#runPlain();
      }
    } finally {
      try { await this.stop(); }
      finally {
        this.acp.off('update', onUpdate);
        this.acp.off('permission', onPermission);
        this.acp.off('permission_cancelled', onCancelled);
        this.acp.off('failed', onFailed);
        this.input.off?.('end', onEnd);
        for (const [name, handler] of signals) process.off(name, handler);
        if (failure) throw failure;
      }
    }
  }

  #openSurface(adopt = false) {
    this.surface = this.terminal.open({ mode: 'inline', title: 'FX', id: 'fx', adopt });
    this.render();
    // Region roots are named by region, not by their own key.
    this.surface.focus('dock.composer');
  }

  #onUpdate(update) {
    if (this.stopping) return;
    this.state.update(update);
    if (!this.surface && this.lines && update?.sessionUpdate === 'agent_message_chunk') {
      this.output.write(safeText(update.content?.text ?? ''));
    }
    this.render();
  }

  #onPermission(request) {
    if (this.stopping) return;
    const options = request.options?.filter(x => typeof x?.optionId === 'string') ?? [];
    if (!options.length) return;
    this.permissionQueue.push({ id: request.id, instance: ++this.permissionSerial, options, tool: safeText(request.toolCall?.title ?? request.toolCall?.name ?? 'Tool action', 250),
      details: safeText(JSON.stringify(request.toolCall?.rawInput ?? {}), 600) });
    this.state.pendingPermission = this.permissionQueue[0];
    if (!this.surface && this.lines) this.#showPlainPermission();
    this.render();
  }

  respondPermission(optionId) {
    const pending = this.state.pendingPermission;
    if (!pending || !pending.options.some(option => option.optionId === optionId)) return false;
    if (!this.acp.respondPermission(pending.id, optionId)) return false;
    this.permissionQueue.shift();
    this.state.pendingPermission = this.permissionQueue[0] ?? null;
    if (!this.surface && this.lines) {
      if (this.state.pendingPermission) this.#showPlainPermission();
      else this.lines.setPrompt('fx> ');
      this.lines.prompt();
    }
    this.render();
    return true;
  }

  #showPlainPermission() {
    const pending = this.state.pendingPermission;
    if (!pending) return;
    this.output.write(`\nFX permission: ${pending.tool}\n${pending.details}\n`);
    for (const [i, option] of pending.options.entries()) this.output.write(`  ${i + 1}. ${safeText(option.name, 100)}\n`);
    this.lines.setPrompt('permission> ');
    this.lines.prompt();
  }

  send(text) {
    if (this.state.busy || this.state.pendingPermission || this.stopping) return false;
    // Native send content is rejected unless it matches the active draft.
    const admitted = this.state.draft.send(text);
    if (admitted === null) return false;
    this.state.beginPrompt(admitted);
    this.render();
    let promise;
    try { promise = this.acp.prompt(admitted); }
    catch (err) { this.state.finishPrompt(err); this.render(); return false; }
    this.turn = promise;
    void promise.then(() => this.state.finishPrompt(), err => this.state.finishPrompt(err))
      .finally(() => { if (this.turn === promise) this.turn = null; this.render(); if (!this.stopping && !this.surface && this.lines) { this.output.write('\n'); this.lines.prompt(); } });
    return true;
  }

  handleEdit(event) {
    if (this.stopping || this.state.busy || this.state.pendingPermission) return false;
    const changed = this.state.draft.edit(event);
    if (changed) this.render();
    return changed;
  }
  handleUndo() {
    if (this.stopping || this.state.busy || this.state.pendingPermission) return false;
    const changed = this.state.draft.undo();
    if (changed) this.render();
    return changed;
  }

  async handleKey(key) {
    const name = key?.name;
    const ctrl = key?.ctrl === true;
    if (this.state.pendingPermission) {
      if (name === 'escape' || (ctrl && name === 'c')) {
        const choice = this.state.pendingPermission.options.find(x => x.kind === 'reject_once' || x.optionId === 'reject_once');
        if (choice) this.respondPermission(choice.optionId);
      } else if (!ctrl && /^[1-9]$/.test(name ?? '')) {
        const choice = this.state.pendingPermission.options[Number(name) - 1];
        if (choice) this.respondPermission(choice.optionId);
      }
      return;
    }
    if (name === 'escape' || (ctrl && (name === 'c' || name === 'd'))) {
      if (this.state.busy) { try { await this.acp.cancel(); } catch (err) { this.state.error = safeText(err.message, 250); this.render(); } }
      else await this.stop();
    }
  }

  render() {
    if (!this.surface || this.stopping) return;
    const { ui, html } = this.sdk;
    const permission = this.state.pendingPermission;
    const cards = this.state.messages.map(message => {
      const header = message.kind === 'tool' ? (message.title || 'FX tool') : message.kind === 'user' ? 'You' : message.kind === 'thought' ? 'Reasoning' : 'FX';
      const content = message.kind === 'tool' ? `${message.status}${message.text ? '\n' + message.text : ''}` : message.text;
      return ui.card({ key: message.id, head: header, tone: message.kind === 'user' ? 'user' : 'neutral' }, ui.md({ key: 'body' }, content));
    });
    if (this.state.error) cards.push(ui.text({ key: 'error', tone: 'danger' }, this.state.error));
    const editor = ui.editor({
      key: 'composer', text: this.state.draft.text, cursor: this.state.draft.cursor, prompt: '> ',
      placeholder: 'Message FX', readonly: Boolean(permission || this.state.busy), sendable: !permission && !this.state.busy,
      onEdit: event => this.handleEdit(event), onUndo: () => this.handleUndo(), onSend: event => this.send(event.text),
    });
    const dock = [editor];
    if (permission) dock.push(ui.card({ key: `permission-${permission.instance}`, head: `Permission: ${permission.tool}` },
      ui.text({ key: 'details' }, permission.details),
      ui.row({ key: 'choices' }, ...permission.options.map((choice, i) =>
        html.button({ key: `p${i}`, onClick: () => {
          if (this.state.pendingPermission === permission) this.respondPermission(choice.optionId);
        } }, `${i + 1}. ${safeText(choice.name, 70)}`)))));
    dock.push(ui.status({ key: 'status' },
      ui.seg({ key: 'state' }, this.state.busy ? 'Running (Ctrl+C to cancel)' : permission ? 'Awaiting tool permission' : 'Ready'),
      ui.seg({ key: 'info', side: 'right' }, safeText(this.state.title || this.state.sessionId, 40))));
    this.surface.render({ main: ui.col({ key: 'history' }, ...cards), dock: ui.col({ key: 'controls' }, ...dock) });
  }

  async #runPlain() {
    this.output.write(`FX ACP session ${safeText(this.state.sessionId, 150)}. Type /quit to exit.\n`);
    this.lines = createInterface({ input: this.input, output: this.output, terminal: Boolean(this.input.isTTY) });
    this.lines.setPrompt('fx> ');
    this.lines.prompt();
    if (this.state.pendingPermission) this.#showPlainPermission();
    this.lines.on('SIGINT', () => { void this.handleKey({ name: 'c', ctrl: true }); });
    await new Promise(resolve => {
      this.lines.on('line', text => {
        const pending = this.state.pendingPermission;
        if (pending) {
          const option = pending.options[Number(text.trim()) - 1];
          if (option) this.respondPermission(option.optionId);
          else this.#showPlainPermission();
          return;
        }
        if (text.trim() === '/quit' || text.trim() === '/exit') { this.lines.close(); return; }
        if (text.trim() === '/cancel') { void this.acp.cancel().catch(err => { this.output.write(safeText(err.message) + '\n'); }); return; }
        if (this.state.busy) { this.output.write('FX is running. Use /cancel or wait.\n'); return; }
        if (!this.state.draft.replace(text)) { this.output.write('Message too long.\n'); return; }
        if (!this.send(text)) this.output.write('Message not sent.\n');
      });
      this.lines.once('close', resolve);
    });
  }

  stop() {
    this.closing ??= this.#stop();
    return this.closing;
  }

  async #stop() {
    this.stopping = true;
    try {
      try { this.terminal ??= await this.connecting; } catch {}
      try {
        if (this.surface && !this.surface.closed) {
          // SDK 0.1.0 close force-flushes queued frames beyond negotiated credits.
          // Retire unsent work and keep only the main view Tern actually received.
          this.surface.gone();
          this.output.write(this.sdk.encodeJson({ verb: 'x', body: { id: this.surface.id, keep: true } }));
        }
      } finally { await this.terminal?.close(); }
    } finally {
      try {
        const outcome = await this.acp.close();
        this.outcome = outcome;
        if (this.acp.failure) throw this.acp.failure;
        if (outcome && (outcome.code !== 0 || outcome.signal !== null)) {
          const error = new Error(`fx acp exited (${outcome.code ?? outcome.signal})${outcome.stderr ? ': ' + outcome.stderr : ''}`);
          error.outcome = outcome;
          throw error;
        }
      }
      finally {
        this.permissionQueue.length = 0;
        this.state.pendingPermission = null;
        this.lines?.close();
        this.input.pause?.();
        this.input.unref?.();
      }
    }
  }
}
