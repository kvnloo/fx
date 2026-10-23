/** UI-only projections. FX owns the transcript, tool state and permissions. */
const LIMIT = 256;
const MAX_TEXT = 24_000;
const MAX_DRAFT = 32_768;

export function safeText(value, max = MAX_TEXT) {
  return String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '�').slice(0, max);
}

export class Draft {
  constructor() { this.text = ''; this.cursor = 0; this.history = []; this.version = 0; }
  replace(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_DRAFT) return false;
    this.#save();
    this.text = text;
    this.cursor = text.length;
    this.version++;
    return true;
  }
  #save() { this.history.push([this.text, this.cursor]); if (this.history.length > 32) this.history.shift(); }
  edit({ from, to, text, cursor, len }) {
    if (!Number.isSafeInteger(len) || len !== this.text.length || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
      || from < 0 || to < from || to > len || typeof text !== 'string' || !Number.isSafeInteger(cursor)) return false;
    const atBoundary = (value, pos) => !(pos > 0 && pos < value.length && /[\uD800-\uDBFF]/.test(value[pos - 1]) && /[\uDC00-\uDFFF]/.test(value[pos]));
    if (!atBoundary(this.text, from) || !atBoundary(this.text, to)) return false;
    const next = this.text.slice(0, from) + text + this.text.slice(to);
    if (Buffer.byteLength(next) > MAX_DRAFT || cursor < 0 || cursor > next.length || !atBoundary(next, cursor)) return false;
    this.#save();
    this.text = next;
    this.cursor = cursor;
    this.version++;
    return true;
  }
  undo() {
    const previous = this.history.pop();
    if (!previous) return false;
    [this.text, this.cursor] = previous;
    this.version++;
    return true;
  }
  send(text) {
    // An atomic send must match the authoritative draft, not a stale UI event.
    if (typeof text !== 'string' || text !== this.text || !text.trim() || Buffer.byteLength(text) > MAX_DRAFT) return null;
    const value = this.text;
    this.history.length = 0;
    this.text = '';
    this.cursor = 0;
    this.version++;
    return value;
  }
}

export class Projection {
  constructor() { this.entries = new Map(); this.serial = 0; this.busy = false; this.error = ''; this.title = ''; this.usage = ''; this.draft = new Draft(); this.pendingPermission = null; this.sessionId = ''; }
  #upsert(id, kind, patch) {
    const before = this.entries.get(id);
    const row = before ?? { id, kind, text: '', title: '', status: '' };
    Object.assign(row, patch);
    this.entries.set(id, row);
    while (this.entries.size > LIMIT) this.entries.delete(this.entries.keys().next().value);
    return row;
  }
  beginPrompt(text) { this.busy = true; this.error = ''; this.#upsert(`local:user:${++this.serial}`, 'user', { text: safeText(text) }); }
  finishPrompt(error) { this.busy = false; if (error) this.error = safeText(error.message ?? error, 1000); }
  update(value) {
    if (!value || typeof value !== 'object') return;
    const type = value.sessionUpdate;
    if (type === 'agent_message_chunk' || type === 'user_message_chunk' || type === 'agent_thought_chunk') {
      const kind = type === 'user_message_chunk' ? 'user' : type === 'agent_thought_chunk' ? 'thought' : 'assistant';
      const identity = value.messageId;
      if (typeof identity !== 'string' || !identity) return;
      const key = `${kind}:${identity}`;
      const row = this.#upsert(key, kind, {});
      row.text = safeText(row.text + (value.content?.text ?? ''));
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      const id = value.toolCallId;
      if (typeof id !== 'string' || !id) return;
      const row = this.#upsert(`tool:${id}`, 'tool', {});
      if (value.title) row.title = safeText(value.title, 300);
      if (value.name && !row.title) row.title = safeText(value.name, 300);
      if (value.status) row.status = safeText(value.status, 60);
      if (value.content) row.text = safeText(JSON.stringify(value.content));
    } else if (type === 'session_info_update') {
      if (value.title) this.title = safeText(value.title, 150);
    } else if (type === 'usage_update') {
      if (Number.isFinite(value.used) && Number.isFinite(value.size)) this.usage = `${value.used}/${value.size} tokens`;
    }
  }
  get messages() { return [...this.entries.values()]; }
}
