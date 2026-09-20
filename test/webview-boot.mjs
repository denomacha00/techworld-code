// Runtime boot smoke-test for media/main.js — NOT a unit test, run manually before shipping the webview.
// node --check only catches PARSE errors; this catches RUNTIME throws (the kind that black-out the panel).
// It stubs just enough DOM to load main.js and fire the real message sequence, then asserts the Brain
// gate lets ONLY reasoning rows through. Faithful on the two things main.js actually uses to find nodes:
// `.className =` (wired into classList) and querySelector by class/id/tag over appended children.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../media/main.js', import.meta.url), 'utf8');

function matches(node, sel) {
  if (!sel || !node) { return false; }
  if (sel[0] === '.') { return node.classList.contains(sel.slice(1)); }
  if (sel[0] === '#') { return node._id === sel.slice(1); }
  return node.tagName === sel.toUpperCase();
}
function makeEl(tag) {
  const cls = {
    _s: new Set(),
    add() { for (const a of arguments) { this._s.add(a); } },
    remove() { for (const a of arguments) { this._s.delete(a); } },
    toggle(c, on) { const has = this._s.has(c); const want = on === undefined ? !has : !!on; if (want) { this._s.add(c); } else { this._s.delete(c); } return want; },
    contains(c) { return this._s.has(c); },
  };
  const e = {
    tagName: (tag || 'div').toUpperCase(), _children: [], dataset: {}, style: {}, _id: '', classList: cls,
    _text: '', _html: '',
    set className(v) { cls._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...cls._s].join(' '); },
    set textContent(v) { this._text = String(v); this._children = []; },
    get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); this._children = []; },
    get innerHTML() { return this._html; },
    set id(v) { this._id = v; }, get id() { return this._id; },
    set title(v) { this._title = v; }, get title() { return this._title || ''; },
    get childElementCount() { return this._children.length; },
    get firstElementChild() { return this._children[0] || null; },
    append() { for (const c of arguments) { this._children.push(c); } },
    appendChild(c) { this._children.push(c); return c; },
    removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) { this._children.splice(i, 1); } return c; },
    remove() {},
    querySelector(sel) { for (const c of this._children) { if (matches(c, sel)) { return c; } const d = c.querySelector && c.querySelector(sel); if (d) { return d; } } return null; },
    querySelectorAll(sel) { let r = []; for (const c of this._children) { if (matches(c, sel)) { r.push(c); } if (c.querySelectorAll) { r = r.concat(c.querySelectorAll(sel)); } } return r; },
    closest() { return null; },
    addEventListener(ev) { (this._listeners || (this._listeners = [])).push(ev); }, removeEventListener() {},
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    focus() {}, blur() {}, click() {},
    set scrollTop(v) { this._st = v; }, get scrollTop() { return this._st || 0; },
    get scrollHeight() { return 100; }, get clientHeight() { return 50; },
  };
  return e;
}

const byId = {};
function getEl(id) { if (!byId[id]) { const e = makeEl('div'); e._id = id; byId[id] = e; } return byId[id]; }
let msgListener = null;
globalThis.document = { getElementById: getEl, createElement: makeEl, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, body: makeEl('body') };
globalThis.window = { addEventListener(ev, fn) { if (ev === 'message') { msgListener = fn; } }, removeEventListener() {} };
globalThis.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return {}; }, setState() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
// navigator is a read-only getter on newer Node — define it instead of assigning.
try { Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText() { return Promise.resolve(); } } }, configurable: true }); } catch { /* already usable */ }

function die(msg, err) { console.log(msg + (err ? ': ' + err.message : '')); if (err) { console.log(err.stack); } process.exit(1); }

try { new Function(src)(); } catch (e) { die('BOOT_FAIL', e); }
console.log('BOOT_OK: main.js loaded without throwing');
if (!msgListener) { die('NO_MESSAGE_LISTENER — the panel never wired up window.onmessage'); }

function fire(m) { try { msgListener({ data: m }); } catch (e) { die('MSG_FAIL on kind=' + m.kind, e); } }

// The exact event kinds the extension posts, including the retry status and reasoning from the screenshot.
const seq = [
  { kind: 'state', connected: true, hasKey: true, models: ['m'], selectedModel: 'm', running: true },
  { kind: 'status', message: 'Working…' },
  { kind: 'status', message: 'Finding a faster server — retrying (attempt 1)…' },
  { kind: 'thinking', text: 'This looks like a portfolio website, so I should check the key files to understand the structure.\n' },
  { kind: 'tool', name: 'read_file', detail: 'README.md' },
  { kind: 'toolResult', summary: 'Read 24 lines' },
  { kind: 'assistantDelta', text: 'Here is the plan. ' },
  { kind: 'assistantDelta', text: 'Doing it now.' },
  { kind: 'checkpoint', id: 'c1', summary: 'edited files' },
  { kind: 'usage', total: 1234, window: 1234, limit: 120000 },
  { kind: 'tool', name: 'user_message', detail: 'one more thing' },
  { kind: 'approval', request: { id: 'a1', kind: 'command', command: 'ls', cwd: '.', purpose: 'list' } },
  { kind: 'error', message: 'Some error' },
  { kind: 'complete' },
];
for (const m of seq) { fire(m); }
console.log('MSG_OK: fired ' + seq.length + ' message kinds, no throw');

// Assert the Brain gate: after this sequence, the panel must hold ONLY the one reasoning row.
setTimeout(() => {
  const list = byId['transcriptList'];
  const rows = list ? list._children : [];
  const texts = rows.map((r) => { const tx = r.querySelector('.tr-text'); return tx ? tx._text : ''; });
  const onlyThink = rows.length > 0 && rows.every((r) => r.classList.contains('tr-think'));
  console.log('BRAIN_ROWS=' + JSON.stringify(texts));
  if (!onlyThink) { die('GATE_LEAK — a non-reasoning row reached the Brain panel'); }
  if (rows.length !== 1) { die('GATE_COUNT — expected exactly 1 reasoning row, got ' + rows.length); }
  const btn = byId['transcriptBtn'];
  console.log('BRAIN_LABEL=' + JSON.stringify(btn ? btn._text : null));
  console.log('ALL_CLEAR: booted, fired every message kind, Brain gate holds');
}, 40);
