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
    this.terminal = null;
    this.surface = null;
    this.lines = null;
    this.stopping = false;
    this.lastPrinted = new Map();
    this.turn = null;
  }

  async run({ resume } = {}) {
    this.acp.on('update', update => this.#onUpdate(update));
    this.acp.on('permission', request => this.#onPermission(request));
    this.acp.on('failed', err => { if (!this.stopping) { this.state.finishPrompt(err); this.render(); void this.stop(); } });
    try {
      this.state.sessionId = await this.acp.start({ resume });
      if (this.sdk && this.input.isTTY && this.output.isTTY) {
        try {
          this.terminal = await this.sdk.connect({
            app: 'fx', version: '0.1.0', features: ['edit', 'undo', 'send'], input: this.input, output: this.output,
          });
        } catch { this.terminal = null; }
      }
      if (this.terminal) {
        this.surface = this.terminal.open({ mode: 'inline', title: 'FX', id: 'fx' });
        this.render();
        this.surface.focus('dock.composer');
        for await (const event of this.terminal) {
          if (this.stopping) break;
          if (event.type === 'key') await this.handleKey(event.key);
          if (event.type === 'event' && event.event.ev === 'gone') break;
        }
      } else {
        await this.#runPlain();
      }
    } finally {
      await this.stop();
    }
  }

  #onUpdate(update) {
    this.state.update(update);
    if (!this.surface && this.lines && update?.sessionUpdate === 'agent_message_chunk') {
      this.output.write(safeText(update.content?.text ?? ''));
    }
    this.render();
  }

  #onPermission(request) {
    const options = request.options?.filter(x => typeof x.optionId === 'string') ?? [];
    if (!options.length) return;
    this.permissionQueue.push({ id: request.id, options, tool: safeText(request.toolCall?.title ?? request.toolCall?.name ?? 'Tool action', 250),
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
      .finally(() => { if (this.turn === promise) this.turn = null; this.render(); if (!this.surface && this.lines) { this.output.write('\n'); this.lines.prompt(); } });
    return true;
  }

  handleEdit(event) {
    if (this.state.busy || this.state.pendingPermission) return false;
    const changed = this.state.draft.edit(event);
    if (changed) this.render();
    return changed;
  }
  handleUndo() {
    if (this.state.busy || this.state.pendingPermission) return false;
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
    if (permission) dock.push(ui.card({ key: 'permission', head: `Permission: ${permission.tool}` },
      ui.text({ key: 'details' }, permission.details),
      ui.row({ key: 'choices' }, ...permission.options.map((choice, i) =>
        html.button({ key: `p${i}`, onClick: () => this.respondPermission(choice.optionId) }, `${i + 1}. ${safeText(choice.name, 70)}`)))));
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

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    try { await this.terminal?.close(); } finally { await this.acp.close(); this.lines?.close(); this.input.pause?.(); this.input.unref?.(); }
  }
}
