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
// A DOM text node: appendable, but never an element — it must never match a selector or be traversed by
// querySelector/querySelectorAll (those guard on the method existing). main.js uses these inside checkpoint
// and approval rows via document.createTextNode(...).
function makeTextNode(t) { return { nodeType: 3, _text: String(t), classList: { contains() { return false; } } }; }
function getEl(id) { if (!byId[id]) { const e = makeEl('div'); e._id = id; byId[id] = e; } return byId[id]; }
let msgListener = null;
globalThis.document = { getElementById: getEl, createElement: makeEl, createTextNode: makeTextNode, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, body: makeEl('body') };
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

// Per-CHAT counter → TOKENS, never dollars. Fire totals through the REAL renderUsage in main.js and assert
// the shipped el.usage text. The money figure lives in the HEADER (keyTotal), not here — so the breaking
// inputs are: comma grouping on a big total, a small total still shown, a cost rate present must NOT turn
// this into dollars (the whole point of the two-location split), cost switched off is still tokens, and
// zero shows nothing. The '$' guard is the regression the user explicitly asked to prevent.
function usageText(m) { fire(Object.assign({ kind: 'usage' }, m)); return byId['usage']._text; }
const cases = [
  { in: { total: 3103392, usdPerMillion: 1.6111, showCost: true }, want: '3,103,392 tokens this chat', why: 'a big total groups with commas and stays TOKENS even with a rate set' },
  { in: { total: 10000, usdPerMillion: 1.6111, showCost: true }, want: '10,000 tokens this chat', why: 'a rate present must not turn the per-chat figure into dollars' },
  { in: { total: 1234, usdPerMillion: 0, showCost: true }, want: '1,234 tokens this chat', why: 'no rate: still tokens' },
  { in: { total: 1234, usdPerMillion: 1.6111, showCost: false }, want: '1,234 tokens this chat', why: 'cost OFF: still tokens' },
  { in: { total: 0, usdPerMillion: 1.6111, showCost: true }, want: '', why: 'zero usage shows nothing' },
];
for (const c of cases) {
  const got = usageText(c.in);
  if (got !== c.want) { die('USAGE_FAIL (' + c.why + '): got ' + JSON.stringify(got) + ' want ' + JSON.stringify(c.want)); }
  if (got.indexOf('$') !== -1) { die('USAGE_FAIL (per-chat must be tokens, never USD): ' + JSON.stringify(got)); }
}
console.log('USAGE_OK: per-chat token rendering holds for ' + cases.length + ' cases');

// Whole-KEY meter → USD in the HEADER (keyTotal), independent of the per-chat token counter. Fire 'billing'
// through the REAL renderBilling and assert byId['keyTotal']. Breaking inputs: spend-against-cap ($x / $y),
// a fresh key (0 → $0.00, never blank), and no cap (spend only, no ' / '). The CRUCIAL one: the two figures
// are INDEPENDENT now — a later token 'usage' updates el.usage WITHOUT touching keyTotal, and vice versa.
function keyTotalText(m) { fire(Object.assign({ kind: 'billing', meterInCents: true }, m)); return byId['keyTotal']._text; }
const bcases = [
  { in: { spentUsd: 0, limitUsd: 1 }, want: '$0.00 / $1.00', why: 'a fresh $1 key reads $0.00 / $1.00, never blank' },
  { in: { spentUsd: 0.5, limitUsd: undefined }, want: '$0.500', why: 'no cap shows spend only, no bar' },
  { in: { spentUsd: 1, limitUsd: 1 }, want: '$1.00 / $1.00', why: 'the $1 test key spent out reads exactly $1.00 / $1.00' },
];
for (const c of bcases) { const got = keyTotalText(c.in); if (got !== c.want) { die('BILLING_FAIL (' + c.why + '): got ' + JSON.stringify(got) + ' want ' + JSON.stringify(c.want)); } }
// keyTotal is now '$1.00 / $1.00'. A per-chat usage event must set el.usage to tokens and leave keyTotal alone.
const perChatAfter = usageText({ total: 3103392, usdPerMillion: 1.6111, showCost: true });
if (perChatAfter !== '3,103,392 tokens this chat') { die('SPLIT_FAIL (usage must set the per-chat node to tokens): got ' + JSON.stringify(perChatAfter)); }
if (byId['keyTotal']._text !== '$1.00 / $1.00') { die('SPLIT_FAIL (a usage event must NOT overwrite the header key total): got ' + JSON.stringify(byId['keyTotal']._text)); }
console.log('BILLING_OK: header key-total + independence from the per-chat counter holds for ' + (bcases.length + 1) + ' cases');

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
