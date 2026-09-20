// Headless stress test for Techword Code.
//
// Drives the REAL compiled AgentSession + OpenAICompatibleClient (from dist-test/) against a local
// fake upstream that speaks the Anthropic Messages SSE wire format. The fake "director" issues a
// realistic sequence of tool calls to build a small multi-file Node project on disk, and INJECTS
// failures between/within turns — mid-stream socket drops, 429s, 500s, and pre-response connection
// resets — to prove the never-stop resilience: the agent must reconnect, retry, and finish the task
// without ever surfacing a fatal error, and the real files + passing tests must land on disk.
//
// Run:  node stress/harness.js
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { AgentSession } = require('../dist-test/src/agent/AgentSession.js');

// ---------- a real temp workspace the agent will build into ----------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'techword-stress-'));
function inWork(p) { return path.join(WORK, p); }

// ---------- the files the "model" will ask to create (real, correct, tests pass) ----------
const FILES = {
  'package.json': JSON.stringify({ name: 'todo', version: '1.0.0', private: true }, null, 2) + '\n',
  'src/todo.js':
`function addTodo(list, text) { return [...list, { id: list.length + 1, text, done: false }]; }
function listTodos(list) { return list; }
function markDone(list, id) { return list.map((t) => (t.id === id ? { ...t, done: true } : t)); }
module.exports = { addTodo, listTodos, markDone };
`,
  'test/todo.test.js':
`const { test } = require('node:test');
const assert = require('node:assert');
const { addTodo, listTodos, markDone } = require('../src/todo.js');
test('add appends an item', () => { const l = addTodo([], 'buy milk'); assert.equal(l.length, 1); assert.equal(l[0].text, 'buy milk'); });
test('list returns all', () => { const l = addTodo(addTodo([], 'a'), 'b'); assert.equal(listTodos(l).length, 2); });
test('done marks the item', () => { let l = addTodo([], 'x'); l = markDone(l, 1); assert.equal(l[0].done, true); });
`,
};

// ---------- SSE helpers ----------
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function emitText(res, index, text) {
  sse(res, { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  sse(res, { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
  sse(res, { type: 'content_block_stop', index });
}
function emitToolCall(res, index, id, name, input) {
  sse(res, { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } });
  sse(res, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  sse(res, { type: 'content_block_stop', index });
}
function finish(res, stopReason) {
  sse(res, { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 42 } });
  sse(res, { type: 'message_stop' });
  res.end();
}
function beginSse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  sse(res, { type: 'message_start', message: { usage: { input_tokens: 100 } } });
}

// ---------- the director: given the turn index, produce that turn's model output ----------
// turnIndex = number of assistant messages already in the conversation (each completed turn adds one).
function directTurn(res, turnIndex) {
  beginSse(res);
  if (turnIndex === 0) {
    emitText(res, 0, 'Let me look at the project structure before I build anything.');
    emitToolCall(res, 1, 'call_ls', 'list_workspace_files', { path: '.', depth: 2 });
    return finish(res, 'tool_use');
  }
  if (turnIndex === 1) {
    emitText(res, 0, "Now I'll scaffold the todo module, its package manifest, and a test file.");
    emitToolCall(res, 1, 'call_edit', 'propose_file_edits', {
      summary: 'Scaffold todo CLI with tests',
      edits: Object.entries(FILES).map(([p, content]) => ({ path: p, content, operation: 'create' })),
    });
    return finish(res, 'tool_use');
  }
  if (turnIndex === 2) {
    emitText(res, 0, "Files are in place. Next I'll run the test suite to verify everything works.");
    emitToolCall(res, 1, 'call_test', 'run_terminal_command', { command: 'node --test', purpose: 'Run the unit tests', cwd: '' });
    return finish(res, 'tool_use');
  }
  // turnIndex >= 3: the tests ran; wrap up with a plain final summary (no tool call → completion).
  emitText(res, 0, 'All done. The todo module is implemented and all three tests pass. The project is ready.');
  return finish(res, 'end_turn');
}

// ---------- failure injection: per (turn, attempt) ----------
// Each list is the outcome for attempt 1, 2, 3... of that turn. 'ok' = serve the real turn.
const FAIL_SCRIPT = {
  0: ['drop', 'ok'],          // mid-stream socket drop, then success  (tests streamTurn retry + resetStream)
  1: ['429', '500', 'ok'],    // rate limit, then server error, then success  (tests client status backoff)
  2: ['reset', 'ok'],         // connection reset before response, then success  (tests pre-response retry)
  3: ['drop', 'ok'],          // drop again on the final turn, then success
};
const attempts = {}; // turnIndex -> count
const seen = { drop: 0, '429': 0, '500': 0, reset: 0 };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msgs = [];
    try { msgs = (JSON.parse(body).messages || []); } catch { /* ignore */ }
    const turnIndex = msgs.filter((m) => m.role === 'assistant').length;
    attempts[turnIndex] = (attempts[turnIndex] || 0) + 1;
    const script = FAIL_SCRIPT[turnIndex] || ['ok'];
    const outcome = script[Math.min(attempts[turnIndex] - 1, script.length - 1)];

    if (outcome === 'reset') { seen.reset++; return req.socket.destroy(); }
    if (outcome === '429') { seen['429']++; res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"slow down"}}'); }
    if (outcome === '500') { seen['500']++; res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"upstream hiccup"}}'); }
    if (outcome === 'drop') {
      seen.drop++;
      beginSse(res);
      emitText(res, 0, 'Let me start on th'); // partial, half-streamed — must be discarded on retry
      return setTimeout(() => res.socket.destroy(), 30); // kill the connection mid-reply
    }
    return directTurn(res, turnIndex);
  });
});

// ---------- fake executor: REAL filesystem + REAL command execution in the temp workspace ----------
const executor = {
  async listFiles(rel) {
    const base = inWork(rel === '.' ? '' : rel);
    try { return fs.readdirSync(base).join('\n') || '(empty)'; } catch { return '(empty)'; }
  },
  async readFile(rel) { try { return fs.readFileSync(inWork(rel), 'utf8'); } catch { return ''; } },
  async searchText() { return 'No matches'; },
  async gitStatus() { return 'clean'; },
  async gitDiff() { return ''; },
  getDiagnostics() { return 'No problems'; },
  async findSymbol() { return ''; },
  async outlineFile() { return ''; },
  async findUsages() { return ''; },
  async webFetch() { return ''; },
  async previewDataUrl() { return ''; },
  async codeMap() { return ''; },
  async computeStringEdit(p) { return { path: p, content: '', operation: 'modify' }; },
  async buildPreviews(edits) { return edits.map((e) => ({ path: e.path, before: '', after: e.content || '', operation: e.operation })); },
  async applyEdits(edits) {
    for (const e of edits) {
      const abs = inWork(e.path);
      if (e.operation === 'delete') { try { fs.unlinkSync(abs); } catch {} continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.content || '', 'utf8');
    }
    return 'ckpt_' + Math.random().toString(36).slice(2, 8);
  },
  async restoreCheckpoint() { return 'restored'; },
  async runCommand(proposal) {
    try {
      const out = execFileSync('node', ['--test'], { cwd: WORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return out.slice(-1500);
    } catch (err) {
      // node --test exits non-zero if tests fail; surface stdout+stderr so the model can see it.
      return `${(err.stdout || '')}${(err.stderr || '')}`.slice(-1500) || `command failed: ${err.message}`;
    }
  },
};

const approvals = { request: () => ({ id: 'a' }), consume: () => true };
const gate = async () => true; // auto-approve every edit and command

// ---------- run it ----------
const events = [];
function emit(ev) {
  events.push(ev);
  if (ev.type === 'status') process.stdout.write(`  · ${ev.message}\n`);
  else if (ev.type === 'tool') process.stdout.write(`  → tool: ${ev.name} ${ev.detail ? '(' + String(ev.detail).slice(0, 60) + ')' : ''}\n`);
  else if (ev.type === 'toolResult') process.stdout.write(`  ✓ ${String(ev.summary).slice(0, 80)}\n`);
  else if (ev.type === 'resetStream') process.stdout.write('  ⟲ resetStream (discarded a half-streamed reply)\n');
  else if (ev.type === 'checkpoint') process.stdout.write(`  ⎇ checkpoint: ${ev.summary}\n`);
  else if (ev.type === 'error') process.stdout.write(`  ✖ ERROR: ${ev.message}\n`);
  else if (ev.type === 'complete') process.stdout.write('  ★ complete\n');
}

function fail(msg) { console.error(`\n✖ STRESS TEST FAILED: ${msg}`); cleanup(); process.exit(1); }
function cleanup() { try { server.close(); } catch {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {} }

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const provider = { id: 'techword-api', displayName: 'Techword', baseUrl: `http://127.0.0.1:${port}`, selectedModel: 'claude-opus-4-8' };
  const session = new AgentSession(provider, 'sk-test-key', executor, approvals, emit, gate);
  session.setMode('act');
  session.setMaxSteps(50);

  console.log(`\nWorkspace: ${WORK}`);
  console.log('Task: build a todo CLI with tests, then run them — through injected drops/429/500/resets.\n');

  const started = Date.now();
  const watchdog = setTimeout(() => fail('timed out after 90s (a retry likely never recovered)'), 90000);
  try {
    await session.run('Build a small Node.js todo module (add/list/done) with a package.json and a passing node:test suite, then run the tests to verify.');
  } catch (e) {
    fail(`run() threw (should never happen — errors go to the emit stream): ${e && e.stack || e}`);
  }
  clearTimeout(watchdog);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  // ---------- assertions ----------
  console.log('\n--- assertions ---');
  const errors = events.filter((e) => e.type === 'error');
  if (errors.length) fail(`surfaced ${errors.length} fatal error(s) to the user: ${errors.map((e) => e.message).join(' | ')}`);
  console.log('✓ never surfaced a fatal error to the user');

  if (!events.some((e) => e.type === 'complete')) fail('never emitted "complete" — the task did not finish');
  console.log('✓ task ran to completion');

  // the failures were actually injected AND recovered from
  if (seen.drop < 2) fail(`expected >=2 mid-stream drops injected, saw ${seen.drop}`);
  if (seen['429'] < 1 || seen['500'] < 1) fail(`expected a 429 and a 500 injected, saw 429=${seen['429']} 500=${seen['500']}`);
  if (seen.reset < 1) fail(`expected a connection reset injected, saw ${seen.reset}`);
  console.log(`✓ failures injected & recovered: drops=${seen.drop}, 429=${seen['429']}, 500=${seen['500']}, resets=${seen.reset}`);

  if (!events.some((e) => e.type === 'resetStream')) fail('a mid-stream drop happened but no resetStream fired (partial text would duplicate)');
  console.log('✓ resetStream discarded half-streamed replies before retrying');

  if (!events.some((e) => e.type === 'status' && /keep retrying|Waiting for your connection/i.test(e.message))) {
    fail('never showed the "keep retrying / waiting for connection" status during a drop');
  }
  console.log('✓ showed the never-stop reconnect status');

  // the REAL project landed on disk, correctly
  for (const rel of Object.keys(FILES)) {
    if (!fs.existsSync(inWork(rel))) fail(`file was not actually written: ${rel}`);
  }
  const wrote = fs.readFileSync(inWork('src/todo.js'), 'utf8');
  if (!wrote.includes('function addTodo')) fail('src/todo.js content is wrong');
  console.log(`✓ all ${Object.keys(FILES).length} project files written to disk with correct content`);

  // the tests actually ran and passed (real node --test in the temp workspace)
  const testResult = events.filter((e) => e.type === 'toolResult').map((e) => e.summary).join('\n');
  const ranTests = events.some((e) => e.type === 'tool' && e.name === 'run_terminal_command');
  if (!ranTests) fail('never ran the test command');
  // Re-run to capture pass/fail deterministically
  let passed = false;
  try { const out = execFileSync('node', ['--test'], { cwd: WORK, encoding: 'utf8' }); passed = /pass 3/.test(out) || /# pass 3/.test(out); } catch { passed = false; }
  if (!passed) fail('the generated test suite did not pass 3/3 under node --test');
  console.log('✓ generated tests pass 3/3 under a real "node --test" run');

  console.log(`\n★ STRESS TEST PASSED in ${secs}s — built a real project and finished despite ${seen.drop + Number(seen['429'] > 0) + Number(seen['500'] > 0) + seen.reset} injected failures.\n`);
  cleanup();
  process.exit(0);
});
