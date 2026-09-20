// Second stress test: the STOP boundary.
//
// The rule is "retry transient failures forever, but STOP immediately on a dead key or exhausted
// tokens." The happy-path harness proved the "retry forever" half. This proves the "stop" half:
//   A) a 401 (invalid/expired key) must stop fast with a clear message — NOT retry forever.
//   B) a 402 (tokens used up) must stop fast with a clear message — NOT retry forever.
//   C) a long sustained outage (many drops in a row) must still eventually recover and finish.
// If a terminal error were mis-tagged as transient, these would hang forever — so each has a tight
// watchdog: recovery/stop must happen quickly, or the test fails.
'use strict';

const http = require('node:http');
const { AgentSession } = require('../dist-test/src/agent/AgentSession.js');

function sse(res, o) { res.write(`data: ${JSON.stringify(o)}\n\n`); }
function beginSse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, { type: 'message_start', message: { usage: { input_tokens: 10 } } });
}

const executor = {
  async listFiles() { return '(empty)'; }, async readFile() { return ''; }, async searchText() { return 'No matches'; },
  async gitStatus() { return ''; }, async gitDiff() { return ''; }, getDiagnostics() { return 'No problems'; },
  async findSymbol() { return ''; }, async outlineFile() { return ''; }, async findUsages() { return ''; },
  async webFetch() { return ''; }, async previewDataUrl() { return ''; }, async codeMap() { return ''; },
  async computeStringEdit(p) { return { path: p, content: '', operation: 'modify' }; },
  async buildPreviews(e) { return e.map((x) => ({ path: x.path, before: '', after: '', operation: x.operation })); },
  async applyEdits() { return 'ckpt'; }, async restoreCheckpoint() { return ''; }, async runCommand() { return 'ok'; },
};
const approvals = { request: () => ({ id: 'a' }), consume: () => true };
const gate = async () => true;

function runScenario(name, handler, { expectComplete, mustMentionRe, maxSeconds, minRequests }) {
  return new Promise((resolve) => {
    let requests = 0;
    const server = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { requests++; handler(res, requests); }); });
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const provider = { id: 'techword-api', displayName: 'T', baseUrl: `http://127.0.0.1:${port}`, selectedModel: 'claude-opus-4-8' };
      const events = [];
      const session2 = new AgentSession(provider, 'sk-test', executor, approvals, (ev) => events.push(ev), gate);
      session2.setMode('act'); session2.setMaxSteps(30);
      const started = Date.now();
      let timedOut = false;
      const wd = setTimeout(() => { timedOut = true; try { session2.stop(); } catch {} }, maxSeconds * 1000);
      await session2.run('Do the task.').catch(() => {});
      clearTimeout(wd);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      try { server.close(); } catch {}

      const errs = events.filter((e) => e.type === 'error');
      const completed = events.some((e) => e.type === 'complete');
      const report = [];
      let ok = true;
      if (timedOut) { ok = false; report.push(`✖ TIMED OUT after ${maxSeconds}s — it retried a terminal error forever (or never recovered)`); }
      if (expectComplete) {
        if (!completed) { ok = false; report.push('✖ expected the task to complete but it did not'); }
        else report.push(`✓ recovered and completed in ${secs}s after a sustained outage (${requests} requests)`);
      } else {
        if (completed) { ok = false; report.push('✖ task "completed" — a dead key/no-tokens must stop, not finish'); }
        if (errs.length === 0) { ok = false; report.push('✖ stopped but surfaced NO message — the user would see nothing'); }
        else {
          const msg = errs.map((e) => e.message).join(' ');
          if (mustMentionRe && !mustMentionRe.test(msg)) { ok = false; report.push(`✖ error shown but unclear: "${msg}"`); }
          else report.push(`✓ stopped fast (${secs}s) with a clear message: "${errs[0].message.slice(0, 80)}…"`);
        }
        if (minRequests && requests > minRequests) { ok = false; report.push(`✖ made ${requests} requests — a terminal error must NOT be retried (expected <= ${minRequests})`); }
        else report.push(`✓ did not retry the terminal error (${requests} request${requests === 1 ? '' : 's'})`);
      }
      console.log(`\n[${name}]`);
      for (const line of report) console.log('  ' + line);
      resolve(ok);
    });
  });
}

(async () => {
  const results = [];

  // A) dead key: always 401
  results.push(await runScenario('A. Dead/expired key (401) → must STOP', (res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"invalid api key"}}');
  }, { expectComplete: false, mustMentionRe: /key|invalid|expired|settings/i, maxSeconds: 20, minRequests: 2 }));

  // B) tokens exhausted: always 402
  results.push(await runScenario('B. Tokens used up (402) → must STOP', (res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"insufficient balance / quota exceeded"}}');
  }, { expectComplete: false, mustMentionRe: /token|balance|top up|used up|quota/i, maxSeconds: 20, minRequests: 2 }));

  // C) sustained outage: reset the first 6 connections, then serve a clean finish
  results.push(await runScenario('C. Sustained outage (6 resets) → must RECOVER', (res, n) => {
    if (n <= 6) { return res.socket.destroy(); }
    beginSse(res);
    sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered after the outage. The task is done.' } });
    sse(res, { type: 'content_block_stop', index: 0 });
    sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
    sse(res, { type: 'message_stop' });
    res.end();
  }, { expectComplete: true, maxSeconds: 80 }));

  const passed = results.every(Boolean);
  console.log(`\n${passed ? '★ ALL STOP-BOUNDARY TESTS PASSED' : '✖ SOME TESTS FAILED'}\n`);
  process.exit(passed ? 0 : 1);
})();
