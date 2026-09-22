(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    log: document.getElementById('log'),
    prompt: document.getElementById('prompt'),
    send: document.getElementById('sendBtn'),
    stop: document.getElementById('stopBtn'),
    newTask: document.getElementById('newTaskBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    settings: document.getElementById('settings'),
    apiKey: document.getElementById('apiKey'),
    saveKey: document.getElementById('saveKeyBtn'),
    test: document.getElementById('testBtn'),
    connMsg: document.getElementById('connMsg'),
    connDot: document.getElementById('connDot'),
    connLatency: document.getElementById('connLatency'),
    connModels: document.getElementById('connModels'),
    modelSelect: document.getElementById('modelSelect'),
    settingsModel: document.getElementById('settingsModel'),
    statusDot: document.getElementById('statusDot'),
    usage: document.getElementById('usage'),
    ctxRing: document.getElementById('ctxRing'),
    ctxArc: document.getElementById('ctxArc'),
    attachBtn: document.getElementById('attachBtn'),
    attachments: document.getElementById('attachments'),
    historyBtn: document.getElementById('historyBtn'),
    historyPanel: document.getElementById('historyPanel'),
    historyList: document.getElementById('historyList'),
    autoEdits: document.getElementById('autoEdits'),
    autoCommands: document.getElementById('autoCommands'),
    mcpStatus: document.getElementById('mcpStatus'),
    keyStatus: document.getElementById('keyStatus'),
    disconnect: document.getElementById('disconnectBtn'),
    modeBtn: document.getElementById('modeBtn'),
    modeBtnLabel: document.getElementById('modeBtnLabel'),
    modeDot: document.getElementById('modeDot'),
    modeMenu: document.getElementById('modeMenu'),
    terminalBtn: document.getElementById('terminalBtn'),
    changesBtn: document.getElementById('changesBtn'),
    previewBtn: document.getElementById('previewBtn'),
    moreBtn: document.getElementById('moreBtn'),
    moreDropdown: document.getElementById('moreDropdown'),
    expandBtn: document.getElementById('expandBtn'),
    minimizeBtn: document.getElementById('minimizeBtn'),
    workbar: document.getElementById('workbar'),
    workbarText: document.getElementById('workbarText'),
    transcriptBtn: document.getElementById('transcriptBtn'),
    transcript: document.getElementById('transcript'),
    transcriptClose: document.getElementById('transcriptClose'),
    transcriptList: document.getElementById('transcriptList'),
    queued: document.getElementById('queued'),
  };

  var MODE_LABELS = { manual: 'Manual', edit: 'Edit', plan: 'Plan', bypass: 'Bypass permissions' };

  let state = { connected: false, hasKey: false, models: [], selectedModel: undefined, running: false };
  let currentAssistant = null; // element accumulating streamed text
  let currentRaw = '';         // raw markdown for the streaming bubble
  let thinkBuf = '';           // unflushed tail of the real reasoning stream, awaiting a sentence break
  let statusEl = null;
  let pendingAtt = [];         // attachments currently staged (with data URLs for images)
  let queuedCache = [];        // messages held while busy, so an edit-cancel can re-render them
  let waitingForAnswer = false; // true while the agent is blocked on an ask_user question

  // ---------- helpers ----------
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Lightweight, language-agnostic syntax coloring for code blocks (operates on escaped text).
  function highlightCode(escaped) {
    const TOKEN = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(0x[0-9a-fA-F]+|\d+\.?\d*)\b|\b(function|const|let|var|if|else|elif|for|while|do|switch|case|break|continue|return|import|export|from|as|class|extends|new|async|await|try|catch|finally|throw|def|lambda|print|public|private|protected|static|void|int|float|double|string|str|bool|boolean|true|false|null|undefined|None|True|False|self|this|def|end|fn|struct|enum|interface|type|package|func)\b/g;
    return escaped.replace(TOKEN, (m, comment, str, num, kw) => {
      if (comment) { return `<span class="tk-c">${comment}</span>`; }
      if (str) { return `<span class="tk-s">${str}</span>`; }
      if (num) { return `<span class="tk-n">${num}</span>`; }
      if (kw) { return `<span class="tk-k">${kw}</span>`; }
      return m;
    });
  }

  // Minimal, safe markdown: escapes first, then adds code blocks, inline code, bold, headers, lists.
  function unescapeHtml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  // Languages we treat as runnable shell commands — these get a Run button in chat.
  var SHELL_LANGS = { bash: 1, sh: 1, shell: 1, zsh: 1, console: 1, powershell: 1, ps1: 1, cmd: 1, bat: 1, batch: 1 };
  // Render a code block. Shell blocks get a toolbar with Run (executes in the terminal, streams the
  // result back here as faded text) and Copy. The raw command rides in a data attribute, URI-encoded.
  function renderCodeBlock(lang, escapedBody) {
    const body = escapedBody.replace(/\n$/, '');
    const isShell = SHELL_LANGS[(lang || '').trim().toLowerCase()] === 1;
    const pre = '<pre><code>' + highlightCode(body) + '</code></pre>';
    if (!isShell) { return pre; }
    const raw = encodeURIComponent(unescapeHtml(body));
    return '<div class="cmd-block" data-cmd="' + raw + '">' +
      '<div class="cmd-bar">' +
        '<span class="cmd-lang">' + (lang || 'shell').trim() + '</span>' +
        '<span class="cmd-actions">' +
          '<button class="cmd-run" title="Run in terminal">▶ Run</button>' +
          '<button class="cmd-copy" title="Copy">⧉ Copy</button>' +
        '</span>' +
      '</div>' + pre +
      '<div class="cmd-output" hidden></div>' +
    '</div>';
  }
  function renderMarkdown(src) {
    const lines = escapeHtml(src).split('\n');
    let html = '';
    let inCode = false;
    let listTag = '';   // '', 'ul' or 'ol' — the open list, so ordered/unordered nest correctly
    let inQuote = false;
    let codeBuf = '';
    let codeLang = '';
    const closeList = () => { if (listTag) { html += '</' + listTag + '>'; listTag = ''; } };
    const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false; } };
    const openList = (tag) => { if (listTag !== tag) { closeList(); html += '<' + tag + '>'; listTag = tag; } };
    for (let raw of lines) {
      const fence = raw.match(/^```(.*)$/);
      if (fence) {
        closeList(); closeQuote();
        if (inCode) { html += renderCodeBlock(codeLang, codeBuf); inCode = false; codeBuf = ''; codeLang = ''; }
        else { inCode = true; codeBuf = ''; codeLang = fence[1] || ''; }
        continue;
      }
      if (inCode) { codeBuf += raw + '\n'; continue; }

      let line = raw
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');

      const h = line.match(/^(#{1,3})\s+(.*)$/);
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      const quote = line.match(/^\s*&gt;\s?(.*)$/); // '>' was escaped to &gt;
      if (h) {
        closeList(); closeQuote();
        const level = h[1].length + 2;
        html += '<h' + level + '>' + h[2] + '</h' + level + '>';
      } else if (ul) {
        closeQuote(); openList('ul');
        html += '<li>' + ul[1] + '</li>';
      } else if (ol) {
        closeQuote(); openList('ol');
        html += '<li>' + ol[1] + '</li>';
      } else if (quote) {
        closeList();
        if (!inQuote) { html += '<blockquote>'; inQuote = true; }
        html += quote[1] + '<br>';
      } else if (line.trim() === '') {
        closeList(); closeQuote();
        html += '<br>';
      } else {
        closeList(); closeQuote();
        html += '<p>' + line + '</p>';
      }
    }
    closeList(); closeQuote();
    if (inCode) html += renderCodeBlock(codeLang, codeBuf);
    return html;
  }

  function clearOnboard() {
    const ob = el.log.querySelector('.onboard');
    if (ob) ob.remove();
  }

  // Autoscroll only when the user is already at (or near) the bottom. If they scroll up to read earlier
  // output while the model streams, we leave them there instead of yanking them back down every token.
  let stickToBottom = true;
  if (el.log) {
    el.log.addEventListener('scroll', () => {
      stickToBottom = (el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight) < 80;
    });
  }
  function scroll(force) { if (force || stickToBottom) { el.log.scrollTop = el.log.scrollHeight; } }
  // The user just acted (sent/picked) — always bring their message and the reply into view.
  function scrollToBottom() { stickToBottom = true; scroll(true); }

  function add(node) { clearOnboard(); el.log.append(node); scroll(); return node; }

  function endAssistant() {
    // Render any tokens still queued for the next frame so the finished bubble is complete before we let go.
    if (renderScheduled && currentAssistant) { renderScheduled = false; currentAssistant.__raw = currentRaw; currentAssistant.__content.innerHTML = renderMarkdown(currentRaw); }
    flushThinking(); currentAssistant = null; currentRaw = '';
  }
  function clearStatus() { stopThinking(); if (statusEl) { statusEl.remove(); statusEl = null; } }

  // Lively "thinking" phrases that rotate while the model is working but not yet streaming, so it
  // never looks frozen. A specific status (from a tool) replaces these.
  let statusTimer = null;
  const THINKING = ['Thinking…', 'Analyzing the request…', 'Planning the next step…', 'Reasoning it through…', 'Looking at the code…', 'Working on it…', 'Figuring out the approach…'];
  function rotateThinking() {
    stopThinking();
    let i = 0;
    showStatus(THINKING[0]);
    statusTimer = setInterval(() => {
      i = (i + 1) % THINKING.length;
      if (statusEl) { const t = statusEl.querySelector('.status-text'); if (t) { t.textContent = THINKING[i]; } }
      else { stopThinking(); }
    }, 2200);
  }
  function stopThinking() { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } }

  // ---------- persistent working bar + activity transcript ----------
  // The workbar stays pinned above the composer the ENTIRE time the agent is busy, so there's always
  // visible motion and a label of the current action — never a frozen gap. The transcript is a
  // toggleable running log of everything it did, for anyone who wants to see the full trail.
  let workbarRotate = null;
  let workbarTick = null;   // per-second elapsed heartbeat for a pinned action
  let pinnedBase = '';      // the action label without the live "· 12s" suffix
  let pinnedStart = 0;
  function stopWorkbarTick() { if (workbarTick) { clearInterval(workbarTick); workbarTick = null; } }
  function renderPinned() {
    if (!el.workbarText) { return; }
    const secs = Math.floor((Date.now() - pinnedStart) / 1000);
    let label = pinnedBase;
    // Quick steps (<3s) stay clean; a slow, silent one (install, tests, big search) keeps ticking so
    // it visibly reads as "still working, here's where we've reached" and never looks frozen.
    if (secs >= 3) { label += ' · ' + secs + 's'; }
    if (secs >= 10) { label += ' · still working…'; }
    el.workbarText.textContent = label;
  }
  function setWork(text) {
    if (!el.workbar) { return; }
    if (text) { el.workbarText.textContent = text; }
  }
  function showWork(on) {
    if (!el.workbar) { return; }
    el.workbar.classList.toggle('hidden', !on);
    if (workbarRotate) { clearInterval(workbarRotate); workbarRotate = null; }
    if (on) {
      // While there's no specific action yet, keep the label lively so it never reads as stuck.
      let i = 0;
      el.workbarText.textContent = THINKING[0];
      workbarRotate = setInterval(() => {
        // Only rotate the generic phrases; a real action label (set via pinWork) stays put.
        if (el.workbarText.dataset.pinned === '1') { return; }
        i = (i + 1) % THINKING.length;
        el.workbarText.textContent = THINKING[i];
      }, 2200);
    } else {
      // Work stopped: drop the pin and the elapsed heartbeat so the next run starts clean.
      stopWorkbarTick();
      if (el.workbarText) { el.workbarText.dataset.pinned = ''; }
    }
  }
  function pinWork(text) { // a concrete action — stop the generic rotation, show it, tick elapsed
    if (!el.workbar) { return; }
    el.workbarText.dataset.pinned = '1';
    pinnedBase = text;
    pinnedStart = Date.now();
    renderPinned();
    stopWorkbarTick();
    // Tick every second so a long silent step (install, tests) keeps visibly moving.
    workbarTick = setInterval(renderPinned, 1000);
  }

  // Activity is the full play-by-play of the CURRENT task — every status, tool call, result and error.
  // It is kept for the whole task (NOT time-expired: a row vanishing after a few minutes is exactly why
  // the panel looked empty during a long step) and only cleared when a new task starts. A generous cap
  // trims the oldest rows so one very long run can't grow the DOM without bound.
  var ACTIVITY_MAX_ROWS = 600;
  // "Show it while working, tidy it away after." The trail is kept intact for the WHOLE task (never
  // time-expired mid-run — that was the empty-panel bug). When the task finishes we arm a grace timer;
  // if nothing new happens and the drawer isn't open for reading, the log clears itself so the next
  // task starts fresh. Any new activity, or the drawer being open, cancels the pending clear.
  var ACTIVITY_CLEAR_MS = 45000;
  var activityClearTimer = null;
  function cancelActivityClear() { if (activityClearTimer) { clearTimeout(activityClearTimer); activityClearTimer = null; } }
  function armActivityClear() {
    cancelActivityClear();
    activityClearTimer = setTimeout(() => {
      activityClearTimer = null;
      // Don't yank the log out from under someone who has the drawer open reading it.
      if (el.transcript && !el.transcript.classList.contains('hidden')) { return; }
      if (el.transcriptList) { el.transcriptList.innerHTML = ''; }
    }, ACTIVITY_CLEAR_MS);
  }
  function logActivity(text, cls) {
    if (!el.transcriptList) { return; }
    if (!text) { return; }
    // The Brain panel shows ONLY the model's real reasoning — what it's thinking, what it plans, how it
    // reads the problem — and nothing else. Tool calls (Read · file), results (↳ Read 24 lines), and
    // status/retry lines (Finding a faster server…) are deliberately dropped here: they're already shown
    // in chat (tool cards) and on the working bar, and mixing them in buried the one line that mattered.
    // So only reasoning rows (tagged 'tr-think' by emitThink) render; every other caller is a no-op for
    // the panel. When there's no reasoning, the panel stays empty — exactly as intended.
    if (cls !== 'tr-think') { return; }
    cancelActivityClear(); // fresh activity → the task is alive again, keep the trail
    const row = document.createElement('div');
    row.className = 'transcript-row' + (cls ? ' ' + cls : '');
    row.dataset.ts = String(Date.now());
    const t = document.createElement('span');
    t.className = 'tr-time';
    const now = new Date();
    t.textContent = now.toTimeString().slice(0, 8);
    const tx = document.createElement('span');
    tx.className = 'tr-text';
    tx.textContent = text;
    row.append(t, tx);
    el.transcriptList.append(row);
    // Trim only the oldest rows past the cap — never time-based, so nothing disappears mid-task.
    while (el.transcriptList.childElementCount > ACTIVITY_MAX_ROWS && el.transcriptList.firstElementChild) {
      el.transcriptList.removeChild(el.transcriptList.firstElementChild);
    }
    el.transcriptList.scrollTop = el.transcriptList.scrollHeight;
  }

  // Drop the terminal output for a Run click under its command block, as faded text (like Claude Code).
  function showCmdResult(token, output, failed) {
    const out = cmdTokens && cmdTokens[token];
    if (!out) { return; }
    out.className = 'cmd-output' + (failed ? ' cmd-failed' : '');
    out.textContent = (output && output.trim()) ? output : (failed ? 'Command failed.' : 'Done (no output).');
    delete cmdTokens[token];
    const block = out.closest && out.closest('.cmd-block');
    const runBtn = block && block.querySelector('.cmd-run');
    if (runBtn) { runBtn.disabled = false; }
    scroll();
  }

  function addUser(text, images) {
    const d = document.createElement('div');
    d.className = 'msg user';
    if (text) { const t = document.createElement('div'); t.textContent = text; d.append(t); }
    (images || []).forEach((img) => {
      if (!img.dataUrl) { return; }
      const el = document.createElement('img');
      el.className = 'msg-img';
      el.src = img.dataUrl;
      el.alt = img.name || 'image';
      d.append(el);
    });
    add(d);
  }

  function makeAssistant() {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const content = document.createElement('div');
    content.className = 'content';
    const copy = document.createElement('button');
    copy.className = 'copy-btn';
    copy.title = 'Copy';
    copy.textContent = '⧉';
    copy.addEventListener('click', () => vscode.postMessage({ kind: 'copy', text: wrap.__raw || content.textContent || '' }));
    wrap.append(copy, content);
    wrap.__content = content;
    return wrap;
  }

  // Coalesce bursts of stream tokens into ONE re-render per animation frame. Re-rendering the whole
  // bubble on every token is O(n²) over a long reply and throws away the DOM (killing text selection)
  // each time; batching to a frame keeps streaming smooth without changing what's shown.
  let renderScheduled = false;
  function flushRender() {
    renderScheduled = false;
    if (!currentAssistant) { return; }
    currentAssistant.__raw = currentRaw;
    currentAssistant.__content.innerHTML = renderMarkdown(currentRaw);
    scroll();
  }
  function appendDelta(text) {
    clearStatus();
    if (!currentAssistant) { currentAssistant = makeAssistant(); add(currentAssistant); }
    currentRaw += text;
    if (!renderScheduled) { renderScheduled = true; requestAnimationFrame(flushRender); }
  }

  // ---------- REAL reasoning → Activity transcript ----------
  // The model's actual extended-thinking stream (a separate channel from the chat answer) is shown,
  // sentence by sentence as it streams, in the Activity transcript as faded rows — so opening Activity
  // shows genuine reasoning live, like Claude Code. The answer itself goes to chat, never here. If the
  // provider can't do thinking these rows simply won't appear; the answer and everything else is unaffected.
  function feedThinking(text) {
    thinkBuf += text;
    let nl;
    while ((nl = thinkBuf.indexOf('\n')) !== -1) {
      const line = thinkBuf.slice(0, nl);
      thinkBuf = thinkBuf.slice(nl + 1);
      handleThinkLine(line);
    }
    // Flush complete sentences from the current (newline-less) partial line so a long thought streams
    // in rather than appearing only at the end. Requires trailing space so mid-number dots don't split.
    let m;
    while ((m = thinkBuf.match(/^(.*?[.!?…])\s+/))) {
      emitThink(m[1]);
      thinkBuf = thinkBuf.slice(m[0].length);
    }
  }
  function handleThinkLine(line) {
    const trimmed = line.trim();
    if (!trimmed) { return; }
    const parts = trimmed.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) || [trimmed];
    for (const p of parts) { emitThink(p); }
  }
  function emitThink(sentence) {
    const clean = stripThinkMd(sentence);
    if (clean) { logActivity(clean, 'tr-think'); }
  }
  function stripThinkMd(s) {
    return s
      .replace(/`([^`]+)`/g, '$1')          // inline code
      .replace(/\*\*([^*]+)\*\*/g, '$1')    // bold
      .replace(/\*([^*]+)\*/g, '$1')        // italic
      .replace(/^\s*#{1,6}\s+/, '')         // heading marker
      .replace(/^\s*[-*+]\s+/, '')          // bullet
      .replace(/^\s*\d+\.\s+/, '')          // numbered list
      .trim();
  }
  function flushThinking() { if (thinkBuf.trim()) { emitThink(thinkBuf.trim()); } thinkBuf = ''; }
  function resetThinking() { thinkBuf = ''; }

  function showStatus(message) {
    endAssistant();
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'status-line';
      const spin = document.createElement('span');
      spin.className = 'spinner';
      const txt = document.createElement('span');
      txt.className = 'status-text';
      statusEl.append(spin, txt);
      add(statusEl);
    }
    statusEl.querySelector('.status-text').textContent = message;
    scroll();
  }

  function toolMeta(name) {
    if (name && name.indexOf('mcp__') === 0) {
      const parts = name.slice(5).split('__');
      return { icon: '🔌', verb: 'MCP' + (parts[0] ? ' · ' + parts[0] : '') };
    }
    return {
      list_workspace_files: { icon: '📁', verb: 'List' },
      read_file: { icon: '📖', verb: 'Read' },
      get_git_status: { icon: '🔀', verb: 'Git status' },
      get_git_diff: { icon: '🔀', verb: 'Git diff' },
      search_workspace: { icon: '🔍', verb: 'Search' },
      get_diagnostics: { icon: '⚠️', verb: 'Problems' },
      find_symbol: { icon: '🧭', verb: 'Find symbol' },
      outline_file: { icon: '🗂', verb: 'Outline' },
      find_usages: { icon: '🔗', verb: 'Usages' },
      code_map: { icon: '🗺️', verb: 'Code map' },
      edit_file: { icon: '✏️', verb: 'Edit' },
      propose_file_edits: { icon: '✏️', verb: 'Edit' },
      run_terminal_command: { icon: '⌨️', verb: 'Run' },
      spawn_explorer: { icon: '🕵️', verb: 'Explore' },
      ask_user: { icon: '❓', verb: 'Question' },
      web_fetch: { icon: '🌐', verb: 'Fetch' },
      preview_in_chat: { icon: '🖼', verb: 'Preview' },
      remember: { icon: '🧠', verb: 'Remember' },
      forget: { icon: '🧠', verb: 'Forget' },
    }[name] || { icon: '•', verb: name };
  }

  let lastToolCard = null;

  // Settle the previous active tool card: swap its spinner for a ✓ so finished steps read as done.
  function settleLastTool() {
    if (lastToolCard && lastToolCard.classList.contains('active')) {
      lastToolCard.classList.remove('active');
      lastToolCard.classList.add('done');
      const spin = lastToolCard.querySelector('.tool-spin');
      if (spin) { spin.className = 'tool-check'; spin.textContent = '✓'; }
    }
  }

  function addTool(name, detail) {
    if (name === 'user_message') {
      // A message you added mid-task. Show it inline so you can see it was picked up, and log it.
      addUser(detail);
      logActivity('You added: ' + detail, 'tr-tool');
      return;
    }
    endAssistant();
    clearStatus();
    settleLastTool();
    const meta = toolMeta(name);
    pinWork(meta.verb + (detail ? ' · ' + detail : ''));
    logActivity(meta.verb + (detail ? ' · ' + detail : ''), 'tr-tool');
    const card = document.createElement('div');
    card.className = 'tool-card active';
    const head = document.createElement('div');
    head.className = 'tool-head';
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = meta.icon;
    const label = document.createElement('span');
    label.className = 'tool-name';
    label.textContent = meta.verb;
    const det = document.createElement('span');
    det.className = 'tool-detail';
    det.textContent = detail;
    const spin = document.createElement('span');
    spin.className = 'tool-spin';
    // File-operating tools: make the path clickable so you can open exactly what it touched.
    const FILE_TOOLS = { read_file: 1, edit_file: 1, outline_file: 1, preview_in_chat: 1, find_usages: 1 };
    if (FILE_TOOLS[name] && detail) {
      const m = /^(.+?):(\d+)\s*$/.exec(detail); // find_usages passes path:line
      const path = (m ? m[1] : detail).trim();
      const line = m ? parseInt(m[2], 10) : undefined;
      if (path && !/\s/.test(path)) {
        det.classList.add('link');
        det.title = 'Open ' + path + ' in the editor';
        det.addEventListener('click', () => vscode.postMessage({ kind: 'openFile', path: path, line: line }));
      }
    }
    head.append(icon, label, det, spin);
    card.append(head);
    lastToolCard = card;
    add(card);
  }

  // Live terminal output, streamed under the running command's card as faded text (like Claude Code) —
  // so you SEE what a command is doing while it runs, not just a tick at the end. Chunks append in place;
  // the box scrolls with its tail and is capped so a noisy build can't grow the DOM without bound.
  const CMD_OUT_MAX = 20000;
  function addCommandOutput(chunk) {
    if (!lastToolCard || !chunk) { return; }
    let box = lastToolCard.querySelector('.tool-cmd-output');
    if (!box) {
      box = document.createElement('pre');
      box.className = 'tool-cmd-output';
      lastToolCard.append(box);
    }
    box.textContent = (box.textContent + chunk).slice(-CMD_OUT_MAX);
    box.scrollTop = box.scrollHeight;
    scroll();
  }

  function addToolResult(summary) {
    settleLastTool();
    if (summary) { logActivity('↳ ' + summary, 'tr-done'); }
    if (!lastToolCard || !summary) { return; }
    // A command already streamed its full output live — don't repeat it as a summary row underneath.
    if (lastToolCard.querySelector('.tool-cmd-output')) { scroll(); return; }
    const res = document.createElement('div');
    res.className = 'tool-result';
    res.textContent = summary;
    lastToolCard.append(res);
    scroll();
  }

  function addError(message) {
    endAssistant();
    clearStatus();
    const d = document.createElement('div');
    d.className = 'error-line';
    const msg = document.createElement('div');
    msg.textContent = message;
    const retry = document.createElement('button');
    retry.className = 'retry-btn';
    retry.textContent = '↻ Retry';
    retry.addEventListener('click', () => { retry.disabled = true; setBusy(true); showStatus('Retrying…'); vscode.postMessage({ kind: 'retry' }); });
    d.append(msg, retry);
    add(d);
  }

  // A stopped turn needs to be actionable, not a dead end: Retry resumes the interrupted task from the
  // last user turn, Copy grabs whatever partial answer had streamed before the stop. Capture the partial
  // text BEFORE endAssistant() clears currentRaw. Copy only appears when there's something to copy.
  function addStopped(partial) {
    endAssistant();
    clearStatus();
    const d = document.createElement('div');
    d.className = 'note-line stopped-line';
    const label = document.createElement('span');
    label.className = 'stopped-label';
    label.textContent = '■ Stopped';
    const actions = document.createElement('span');
    actions.className = 'stopped-actions';
    const retry = document.createElement('button');
    retry.className = 'retry-btn';
    retry.textContent = '↻ Retry';
    retry.addEventListener('click', () => { retry.disabled = true; setBusy(true); showStatus('Retrying…'); vscode.postMessage({ kind: 'retry' }); });
    actions.append(retry);
    if (partial && partial.trim()) {
      const copy = document.createElement('button');
      copy.className = 'retry-btn';
      copy.textContent = '⧉ Copy';
      copy.addEventListener('click', () => { vscode.postMessage({ kind: 'copy', text: partial }); copy.textContent = '✓ Copied'; setTimeout(() => { copy.textContent = '⧉ Copy'; }, 1200); });
      actions.append(copy);
    }
    d.append(label, actions);
    add(d);
  }

  // A proper line diff via longest-common-subsequence, so duplicate lines, moves, and reordering render
  // correctly (the old set-membership version collapsed duplicates and mislabelled moved lines).
  function renderDiff(oldText, newText) {
    const a = oldText ? oldText.split('\n') : [];
    const b = newText ? newText.split('\n') : [];
    const container = document.createElement('div');
    container.className = 'diff';
    diffLines(a, b).forEach((r) => container.append(diffLine(r.sign, r.text, r.cls)));
    return container;
  }

  function diffLines(a, b) {
    const n = a.length, m = b.length;
    const MAX = 1500; // cap the O(n·m) table so a huge file preview never freezes the panel
    if (n > MAX || m > MAX) {
      return a.map((l) => ({ sign: '-', text: l, cls: 'del' }))
        .concat(b.map((l) => ({ sign: '+', text: l, cls: 'add' })));
    }
    const dp = [];
    for (let i = 0; i <= n; i++) { dp.push(new Uint16Array(m + 1)); }
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const rows = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { rows.push({ sign: ' ', text: a[i], cls: '' }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ sign: '-', text: a[i], cls: 'del' }); i++; }
      else { rows.push({ sign: '+', text: b[j], cls: 'add' }); j++; }
    }
    while (i < n) { rows.push({ sign: '-', text: a[i++], cls: 'del' }); }
    while (j < m) { rows.push({ sign: '+', text: b[j++], cls: 'add' }); }
    return rows;
  }

  function diffLine(sign, text, cls) {
    const row = document.createElement('div');
    row.className = 'line' + (cls ? ' ' + cls : '');
    const s = document.createElement('span');
    s.className = 'sign';
    s.textContent = sign;
    const t = document.createElement('span');
    t.className = 'txt';
    t.textContent = text;
    row.append(s, t);
    return row;
  }

  function addApproval(request, auto, warning) {
    endAssistant();
    clearStatus();
    const card = document.createElement('div');
    card.className = 'approval';
    card.dataset.id = request.id;

    const head = document.createElement('div');
    head.className = 'ap-head';
    head.textContent = request.kind === 'edits' ? 'Review file changes' : request.kind === 'mcp' ? 'Review MCP tool call' : 'Review terminal command';
    card.append(head);

    const body = document.createElement('div');
    body.className = 'ap-body';

    if (request.kind === 'edits') {
      if (request.summary) {
        const sum = document.createElement('p');
        sum.className = 'summary';
        sum.textContent = request.summary;
        body.append(sum);
      }
      request.previews.forEach((p) => {
        const block = document.createElement('div');
        block.className = 'file-block';
        const fh = document.createElement('div');
        fh.className = 'file-head';
        const badge = document.createElement('span');
        badge.className = 'badge ' + p.operation;
        badge.textContent = p.operation;
        const path = document.createElement('span');
        path.textContent = p.renameTo ? p.path + ' → ' + p.renameTo : p.path;
        fh.append(badge, path);
        block.append(fh);
        if (p.operation !== 'delete' && p.operation !== 'rename') {
          block.append(renderDiff(p.oldContent, p.newContent));
        }
        if (p.truncated) {
          const t = document.createElement('div');
          t.className = 'cmd-meta';
          t.textContent = 'Large file — preview truncated.';
          block.append(t);
        }
        body.append(block);
      });
    } else if (request.kind === 'mcp') {
      const server = document.createElement('div');
      server.className = 'cmd-meta';
      server.textContent = 'Server: ' + request.server + '  ·  Tool: ' + request.tool;
      const args = document.createElement('div');
      args.className = 'cmd';
      args.textContent = request.argsJson;
      body.append(server, args);
    } else {
      const purpose = document.createElement('div');
      purpose.className = 'cmd-meta';
      purpose.textContent = 'Purpose: ' + request.purpose;
      const cwd = document.createElement('div');
      cwd.className = 'cmd-meta';
      cwd.textContent = 'Directory: ' + request.cwd;
      const cmd = document.createElement('div');
      cmd.className = 'cmd';
      cmd.textContent = request.command;
      body.append(purpose, cwd, cmd);
    }
    card.append(body);

    if (warning) {
      const warn = document.createElement('div');
      warn.className = 'ap-warning';
      warn.textContent = '⚠ ' + warning;
      card.append(warn);
    }

    if (auto) {
      const status = document.createElement('div');
      status.className = 'ap-status approved';
      status.textContent = '⚡ Auto-approved';
      card.append(status);
      add(card);
      return;
    }

    const actions = document.createElement('div');
    actions.className = 'ap-actions';
    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = request.kind === 'edits' ? 'Approve changes' : request.kind === 'mcp' ? 'Run tool' : 'Run command';
    const reject = document.createElement('button');
    reject.className = 'secondary';
    reject.textContent = 'Reject';
    approve.addEventListener('click', () => respond(request.id, true));
    reject.addEventListener('click', () => respond(request.id, false));
    actions.append(approve, reject);
    card.append(actions);
    add(card);
  }

  function respond(id, approved) {
    vscode.postMessage({ kind: 'approvalResponse', id, approved });
  }

  function resolveApproval(id, approved) {
    const card = el.log.querySelector('.approval[data-id="' + id + '"]');
    if (!card || card.querySelector('.ap-status')) return;
    const actions = card.querySelector('.ap-actions');
    if (actions) actions.remove();
    const status = document.createElement('div');
    status.className = 'ap-status ' + (approved ? 'approved' : 'rejected');
    status.textContent = approved ? '✓ Approved' : '✕ Rejected';
    card.append(status);
  }

  function addNote(text) {
    endAssistant();
    clearStatus();
    const d = document.createElement('div');
    d.className = 'note-line';
    d.textContent = text;
    add(d);
  }

  function addQuestion(text, options) {
    endAssistant();
    clearStatus();
    logActivity('Asked: ' + text);
    const d = document.createElement('div');
    d.className = 'question-line';
    const q = document.createElement('div');
    q.innerHTML = renderMarkdown(text);
    d.append(q);
    const opts = Array.isArray(options) ? options.filter((o) => typeof o === 'string' && o.trim()) : [];
    if (opts.length > 0) {
      const box = document.createElement('div');
      box.className = 'q-options';
      opts.forEach((opt, i) => {
        const b = document.createElement('button');
        b.className = 'q-option';
        const key = document.createElement('span');
        key.className = 'qo-key';
        key.textContent = (i + 1) + '.';
        const lab = document.createElement('span');
        lab.textContent = opt;
        b.append(key, lab);
        b.addEventListener('click', () => {
          if (b.classList.contains('picked')) { return; }
          // Lock the whole set once one is chosen, so a client can't double-answer.
          box.querySelectorAll('.q-option').forEach((x) => { x.classList.add('picked'); x.disabled = true; });
          waitingForAnswer = false;
          addUser(opt);
          scrollToBottom();
          vscode.postMessage({ kind: 'submit', prompt: opt });
          setBusy(true);
        });
        box.append(b);
      });
      d.append(box);
    }
    const hint = document.createElement('div');
    hint.className = 'question-hint';
    hint.textContent = opts.length > 0
      ? 'Click an option, or type your own answer below and press Send.'
      : 'Type your answer below and press Send.';
    d.append(hint);
    add(d);
    el.prompt.focus();
  }

  // ---------- queued messages (held while busy; editable before pickup) ----------
  function renderQueued(items) {
    if (!el.queued) { return; }
    queuedCache = items || [];
    el.queued.innerHTML = '';
    (items || []).forEach((item) => {
      const chip = document.createElement('div');
      chip.className = 'queued-chip';
      chip.dataset.id = item.id;

      const icon = document.createElement('span');
      icon.className = 'qc-icon';
      icon.textContent = '⏳';

      const body = document.createElement('div');
      body.className = 'qc-text';
      body.textContent = item.text;

      const actions = document.createElement('div');
      actions.className = 'qc-actions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'qc-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.title = 'Copy this text';
      copyBtn.addEventListener('click', () => vscode.postMessage({ kind: 'copy', text: item.text }));

      const editBtn = document.createElement('button');
      editBtn.className = 'qc-btn';
      editBtn.textContent = 'Edit';
      editBtn.title = 'Edit before Techword picks it up';
      editBtn.addEventListener('click', () => startEditQueued(chip, item));

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'qc-btn';
      cancelBtn.textContent = '↶ Cancel';
      cancelBtn.title = 'Remove this queued message (rewind)';
      cancelBtn.addEventListener('click', () => vscode.postMessage({ kind: 'cancelQueued', id: item.id }));

      actions.append(copyBtn, editBtn, cancelBtn);
      chip.append(icon, body, actions);
      el.queued.append(chip);
    });
    if ((items || []).length > 0) {
      const hint = document.createElement('div');
      hint.className = 'queued-hint';
      hint.textContent = 'Held until the current step finishes. Techword will pick it up and tell you how it fits in.';
      el.queued.append(hint);
    }
  }

  function startEditQueued(chip, item) {
    // Tell the host we're editing so it refreshes this message's grace window and won't fold it into
    // the task while the user is still typing.
    vscode.postMessage({ kind: 'touchQueued', id: item.id });
    chip.innerHTML = '';
    chip.classList.add('editing');
    const ta = document.createElement('textarea');
    ta.value = item.text;
    const actions = document.createElement('div');
    actions.className = 'qc-actions';
    const save = document.createElement('button');
    save.className = 'qc-btn';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      const v = ta.value.trim();
      if (v) { vscode.postMessage({ kind: 'editQueued', id: item.id, text: v }); }
      else { vscode.postMessage({ kind: 'cancelQueued', id: item.id }); }
    });
    const cancel = document.createElement('button');
    cancel.className = 'qc-btn';
    cancel.textContent = 'Discard edit';
    cancel.addEventListener('click', () => renderQueued(queuedCache));
    actions.append(save, cancel);
    const wrap = document.createElement('div');
    wrap.className = 'qc-edit';
    wrap.append(ta);
    chip.append(wrap, actions);
    ta.focus();
  }

  function addPreview(dataUrl, name) {
    endAssistant();
    clearStatus();
    const wrap = document.createElement('div');
    wrap.className = 'preview-block';
    const img = document.createElement('img');
    img.className = 'preview-img';
    img.src = dataUrl;
    img.alt = name || 'preview';
    const cap = document.createElement('div');
    cap.className = 'preview-cap';
    cap.textContent = name || '';
    wrap.append(img, cap);
    add(wrap);
  }

  function addCheckpoint(id, summary) {
    clearStatus();
    const row = document.createElement('div');
    row.className = 'checkpoint';
    const label = document.createElement('span');
    label.textContent = '✓ Applied: ' + (summary || 'changes');
    const revert = document.createElement('button');
    revert.className = 'secondary revert';
    revert.textContent = '↶ Revert';
    revert.addEventListener('click', () => { revert.disabled = true; revert.textContent = 'Reverted'; vscode.postMessage({ kind: 'revert', id }); });
    row.append(label, revert);
    add(row);
  }

  // ---------- attachments ----------
  function renderAttachments(items) {
    pendingAtt = items || [];
    el.attachments.innerHTML = '';
    pendingAtt.forEach((a) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const icon = document.createElement('span');
      if (a.kind === 'image' && a.dataUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'chip-thumb';
        thumb.src = a.dataUrl;
        icon.append(thumb);
      } else {
        icon.textContent = a.kind === 'image' ? '🖼' : '📄';
      }
      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = a.name;
      const x = document.createElement('button');
      x.className = 'chip-x';
      x.textContent = '×';
      x.title = 'Remove';
      x.addEventListener('click', () => vscode.postMessage({ kind: 'removeAttachment', id: a.id }));
      chip.append(icon, name, x);
      el.attachments.append(chip);
    });
  }

  // ---------- history ----------
  // Opening History posts a message and waits for the host to reply with the saved chats. Show an
  // indeterminate loading bar (a line sweeping end-to-end) the instant the panel opens, so it never
  // looks empty/broken during that round-trip. renderHistory() replaces it the moment items arrive.
  function showHistoryLoading() {
    el.historyList.innerHTML = '';
    const load = document.createElement('div');
    load.className = 'hist-loading';
    load.setAttribute('role', 'progressbar');
    load.setAttribute('aria-label', 'Loading chat history');
    const bar = document.createElement('div');
    bar.className = 'hist-loading-bar';
    load.append(bar);
    el.historyList.append(load);
  }
  function requestHistory() {
    showHistoryLoading();
    vscode.postMessage({ kind: 'history' });
  }
  function renderHistory(items, currentId) {
    el.historyList.innerHTML = '';
    if (!items || items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No saved chats yet.';
      el.historyList.append(empty);
      return;
    }
    items.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'hist-row' + (c.id === currentId ? ' current' : '');
      const open = document.createElement('button');
      open.className = 'hist-open';
      const title = document.createElement('span');
      title.className = 'hist-title';
      title.textContent = c.title;
      const meta = document.createElement('span');
      meta.className = 'hist-meta';
      meta.textContent = new Date(c.updatedAt).toLocaleString();
      open.append(title, meta);
      open.addEventListener('click', () => { vscode.postMessage({ kind: 'loadConversation', id: c.id }); el.historyPanel.classList.add('hidden'); });
      const del = document.createElement('button');
      del.className = 'hist-del';
      del.textContent = '🗑';
      del.title = 'Delete';
      del.addEventListener('click', () => vscode.postMessage({ kind: 'deleteConversation', id: c.id }));
      row.append(open, del);
      el.historyList.append(row);
    });
  }

  function loadDisplay(title, items) {
    el.log.innerHTML = '';
    endAssistant();
    clearStatus();
    (items || []).forEach((it) => {
      if (it.role === 'user') { addUser(it.text); }
      else {
        const d = makeAssistant();
        d.__raw = it.text;
        d.__content.innerHTML = renderMarkdown(it.text);
        el.log.append(d);
      }
    });
    scrollToBottom();
  }

  // The usage counter. Shows an estimated cost in USD (default) using the same running token total,
  // converted at the provider's price-per-million rate (settable in Settings). Falls back to a raw
  // token count when cost display is off or no rate is known. The exact token count is always kept in
  // the hover tooltip so the underlying number is never lost.
  function formatUsd(dollars) {
    // Show enough decimals that a small session isn't rounded to a meaningless $0.00: cents once we're
    // past a dollar, more precision for tiny amounts so early spend is still visible.
    if (dollars >= 1) { return '$' + dollars.toFixed(2); }
    if (dollars >= 0.01) { return '$' + dollars.toFixed(3); }
    if (dollars > 0) { return '$' + dollars.toFixed(4); }
    return '$0.00';
  }
  function renderUsage(m) {
    if (!el.usage) { return; }
    var total = (typeof m.total === 'number' && m.total > 0) ? m.total : 0;
    if (!total) { el.usage.textContent = ''; el.usage.removeAttribute('title'); return; }
    var tokenText = total.toLocaleString() + ' tokens';
    var rate = (typeof m.usdPerMillion === 'number' && m.usdPerMillion > 0) ? m.usdPerMillion : 0;
    if (m.showCost !== false && rate > 0) {
      var dollars = total * rate / 1000000;
      el.usage.textContent = formatUsd(dollars);
      el.usage.title = tokenText + '  ·  ' + formatUsd(dollars) + ' at $' + rate + '/M tokens';
    } else {
      el.usage.textContent = tokenText;
      el.usage.title = tokenText;
    }
  }

  // The blue context ring (Claude-Code style): fills as the current request fills the context window,
  // and drops back down after a compact (window shrinks). window = tokens in the last request, limit =
  // the context budget. Both come from the 'usage' event.
  var CTX_CIRCUMFERENCE = 43.98; // 2·π·7, matches the SVG r=7 and the CSS stroke-dasharray
  function updateContextRing(windowTokens, limit) {
    if (!el.ctxRing || !el.ctxArc) { return; }
    var used = (typeof windowTokens === 'number' && windowTokens > 0) ? windowTokens : 0;
    var cap = (typeof limit === 'number' && limit > 0) ? limit : 0;
    if (!used || !cap) { el.ctxRing.classList.add('hidden'); return; }
    var frac = Math.max(0, Math.min(1, used / cap));
    el.ctxArc.style.strokeDashoffset = String(CTX_CIRCUMFERENCE * (1 - frac));
    var pct = Math.round(frac * 100);
    el.ctxRing.classList.remove('hidden', 'warn', 'full');
    if (frac >= 0.9) { el.ctxRing.classList.add('full'); }
    else if (frac >= 0.7) { el.ctxRing.classList.add('warn'); }
    el.ctxRing.title = 'Context ' + pct + '% full (~' + Math.round(used / 1000) + 'K of ' + Math.round(cap / 1000) + 'K tokens)';
  }

  function setBusy(b) {
    el.stop.classList.toggle('hidden', !b);
    el.send.disabled = false; // never lock input; typing queues onto the task
    // Pulsing glow on the header dot while working, so it's obvious it's alive.
    el.statusDot.classList.toggle('working', b);
    showWork(b); // the always-visible working bar above the composer
    if (!b) { stopThinking(); settleLastTool(); }
    el.prompt.placeholder = b
      ? 'Working… type to add to the task (sent when the current step finishes)'
      : 'Describe what to build, fix, test, or run… Attach with 📎, reference files with @path. Ctrl/Cmd+Enter to send.';
  }

  // ---------- state / UI wiring ----------
  function applyState(s) {
    state = s;
    el.statusDot.className = 'dot' + (s.connected ? ' connected' : (s.hasKey ? ' error' : ''));
    el.keyStatus.textContent = s.hasKey ? ('Active key: ' + (s.keyHint || 'set')) : 'No key set.';
    el.disconnect.classList.toggle('hidden', !s.hasKey);
    fillModels(el.modelSelect, s);
    fillModels(el.settingsModel, s);
    setBusy(!!s.running); // authoritative: a state refresh both starts AND clears the bar, so a
                          // task that ended without a terminal event can never leave it stuck animating
    var am = s.agentMode || 'manual';
    if (el.modeBtnLabel) {
      el.modeBtnLabel.textContent = MODE_LABELS[am] || 'Manual';
      el.modeBtn.dataset.mode = am;
      el.modeBtn.classList.toggle('mode-plan', am === 'plan');
      el.modeBtn.classList.toggle('mode-bypass', am === 'bypass');
      if (el.modeMenu) {
        el.modeMenu.querySelectorAll('.mode-opt').forEach(function (o) {
          o.classList.toggle('active', o.dataset.mode === am);
        });
      }
    }
    if (s.autoApprove) {
      el.autoEdits.checked = !!s.autoApprove.edits;
      el.autoCommands.checked = !!s.autoApprove.commands;
    }
    renderMcp(s.mcp);
    if (!s.hasKey && !el.log.querySelector('.msg') && !el.log.querySelector('.onboard')) {
      showOnboard();
    }
  }

  function renderMcp(list) {
    if (!el.mcpStatus) { return; }
    el.mcpStatus.innerHTML = '';
    if (!list || !list.length) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty';
      empty.textContent = 'None connected.';
      el.mcpStatus.append(empty);
      return;
    }
    list.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'mcp-row';
      const dot = document.createElement('span');
      dot.className = 'mcp-dot ' + (m.running ? 'on' : 'off');
      const name = document.createElement('span');
      name.className = 'mcp-name';
      name.textContent = m.server;
      const meta = document.createElement('span');
      meta.className = 'mcp-meta';
      meta.textContent = m.error ? m.error : (m.running ? (m.toolCount + ' tool' + (m.toolCount === 1 ? '' : 's')) : 'stopped');
      row.append(dot, name, meta);
      el.mcpStatus.append(row);
    });
  }

  function sendAutoApprove() {
    vscode.postMessage({ kind: 'setAutoApprove', edits: el.autoEdits.checked, commands: el.autoCommands.checked });
  }

  function fillModels(select, s) {
    select.innerHTML = '';
    s.models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === s.selectedModel) opt.selected = true;
      select.append(opt);
    });
  }

  function showOnboard() {
    const ob = document.createElement('div');
    ob.className = 'onboard';
    ob.innerHTML = '<h3>Welcome to Techword Code</h3><p>Add your Techword API key in settings to start coding.</p>';
    const btn = document.createElement('button');
    btn.textContent = 'Open settings';
    btn.addEventListener('click', () => el.settings.classList.remove('hidden'));
    ob.append(btn);
    el.log.append(ob);
  }

  el.send.addEventListener('click', () => {
    const text = el.prompt.value.trim();
    if (!text && pendingAtt.length === 0) return;
    // If it's busy (and not waiting on a question), this becomes a HELD message — shown as an
    // editable chip, not a user bubble — so it's clear it hasn't been acted on yet. The backend
    // posts a 'queued' update that renders the chip; we just clear the box.
    const answering = waitingForAnswer;
    const busy = state.running && !answering;
    if (!busy) { addUser(text, pendingAtt.filter((a) => a.kind === 'image')); scrollToBottom(); }
    if (answering) { waitingForAnswer = false; }
    vscode.postMessage({ kind: 'submit', prompt: text });
    el.prompt.value = '';
    if (!busy) { setBusy(true); rotateThinking(); } // instant, lively feedback so it never looks frozen
  });
  el.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); el.send.click(); }
  });
  el.stop.addEventListener('click', () => {
    vscode.postMessage({ kind: 'stop' });
    const partial = currentRaw; // grab the streamed-so-far answer before addStopped()→endAssistant() clears it
    clearStatus();
    setBusy(false);
    addStopped(partial);
    logActivity('Stopped.', 'tr-error');
    armActivityClear();
  });
  el.newTask.addEventListener('click', () => {
    vscode.postMessage({ kind: 'newTask' });
    cancelActivityClear();
    el.log.innerHTML = '';
    el.usage.textContent = '';
    updateContextRing(0, 0); // fresh chat → empty ring
    endAssistant();
    clearStatus();
    setBusy(false);
    if (el.transcriptList) { el.transcriptList.innerHTML = ''; }
    if (el.queued) { el.queued.innerHTML = ''; }
    queuedCache = [];
    waitingForAnswer = false;
  });

  // Activity transcript: open/close the running log of what Techword is doing.
  function toggleTranscript(open) {
    if (!el.transcript) { return; }
    const show = open === undefined ? el.transcript.classList.contains('hidden') : open;
    if (show) { cancelActivityClear(); } // opened to read it → don't tidy it away underneath them
    el.transcript.classList.toggle('hidden', !show);
    if (el.transcriptBtn) { el.transcriptBtn.textContent = 'Brain ⋯'; }
    // Hide the blue working-bar while the Activity drawer is open so you never see two stacked
    // "Activity" surfaces — the drawer you opened is the only one on screen. Restored on close
    // (only if it's still meant to be showing — workState tracks whether Techword is busy).
    if (el.workbar) { el.workbar.classList.toggle('workbar-behind-drawer', show); }
    if (show && el.transcriptList) { el.transcriptList.scrollTop = el.transcriptList.scrollHeight; }
  }
  if (el.transcriptBtn) { el.transcriptBtn.addEventListener('click', () => toggleTranscript()); }
  if (el.transcriptClose) { el.transcriptClose.addEventListener('click', () => toggleTranscript(false)); }
  function toggleModeMenu(open) {
    const show = open === undefined ? el.modeMenu.classList.contains('hidden') : open;
    el.modeMenu.classList.toggle('hidden', !show);
    el.modeBtn.setAttribute('aria-expanded', String(show));
  }
  el.modeBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleModeMenu(); });
  el.modeMenu.querySelectorAll('.mode-opt').forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ kind: 'setAgentMode', mode: opt.dataset.mode });
      toggleModeMenu(false);
    });
  });
  // Close the menu when clicking anywhere else.
  document.addEventListener('click', () => { if (!el.modeMenu.classList.contains('hidden')) { toggleModeMenu(false); } });

  // Run / Copy on shell code blocks in chat (delegated, since bubbles are re-rendered as they stream).
  var cmdTokenSeq = 0;
  var cmdTokens = {}; // token -> the .cmd-output element waiting for this run's result
  el.log.addEventListener('click', (e) => {
    const runBtn = e.target.closest && e.target.closest('.cmd-run');
    const copyBtn = e.target.closest && e.target.closest('.cmd-copy');
    if (!runBtn && !copyBtn) { return; }
    const block = e.target.closest('.cmd-block');
    if (!block) { return; }
    const command = decodeURIComponent(block.dataset.cmd || '');
    if (!command) { return; }
    if (copyBtn) {
      vscode.postMessage({ kind: 'copy', text: command });
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = '⧉ Copy'; }, 1200);
      return;
    }
    // Run: send to the extension, show a live "running" line, and stream the terminal output back here.
    const token = 'cmd_' + (++cmdTokenSeq);
    const out = block.querySelector('.cmd-output');
    if (out) { out.hidden = false; out.className = 'cmd-output cmd-running'; out.textContent = '▶ Running…'; cmdTokens[token] = out; }
    runBtn.disabled = true;
    vscode.postMessage({ kind: 'runCommand', command: command, token: token });
  });

  // Header window controls: expand the panel wide (full-screen feel) / restore, and minimize (hide it).
  var expanded = false;
  if (el.expandBtn) {
    el.expandBtn.addEventListener('click', () => {
      expanded = !expanded;
      vscode.postMessage({ kind: 'layout', action: expanded ? 'expand' : 'restore' });
      el.expandBtn.title = expanded ? 'Restore width' : 'Expand / restore width';
    });
  }
  if (el.minimizeBtn) { el.minimizeBtn.addEventListener('click', () => vscode.postMessage({ kind: 'layout', action: 'minimize' })); }

  el.terminalBtn.addEventListener('click', () => vscode.postMessage({ kind: 'openTerminal' }));
  el.changesBtn.addEventListener('click', () => vscode.postMessage({ kind: 'showChanges' }));
  el.previewBtn.addEventListener('click', () => vscode.postMessage({ kind: 'preview' }));
  el.attachBtn.addEventListener('click', () => vscode.postMessage({ kind: 'attach' }));
  el.historyBtn.addEventListener('click', () => {
    const showing = el.historyPanel.classList.toggle('hidden');
    if (!showing) { requestHistory(); el.settings.classList.add('hidden'); }
  });
  el.settingsBtn.addEventListener('click', () => { el.settings.classList.toggle('hidden'); el.historyPanel.classList.add('hidden'); });

  // ---------- 3-dot "more options" menu ----------
  function toggleMoreMenu(open) {
    const show = open === undefined ? el.moreDropdown.classList.contains('hidden') : open;
    el.moreDropdown.classList.toggle('hidden', !show);
    el.moreBtn.setAttribute('aria-expanded', String(show));
  }
  el.moreBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMoreMenu(); });
  el.moreDropdown.querySelectorAll('.more-opt').forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMoreMenu(false);
      const act = opt.dataset.act;
      if (act === 'rename') { vscode.postMessage({ kind: 'renameConversation' }); }
      else if (act === 'fork') { vscode.postMessage({ kind: 'forkConversation' }); }
      else if (act === 'files') { vscode.postMessage({ kind: 'conversationFiles' }); }
      else if (act === 'memory') { vscode.postMessage({ kind: 'memory' }); }
      else if (act === 'outputStyle') { vscode.postMessage({ kind: 'chooseOutputStyle' }); }
      else if (act === 'history') { el.historyPanel.classList.remove('hidden'); el.settings.classList.add('hidden'); requestHistory(); }
      else if (act === 'settings') { el.settings.classList.toggle('hidden'); el.historyPanel.classList.add('hidden'); }
    });
  });
  document.addEventListener('click', () => { if (!el.moreDropdown.classList.contains('hidden')) { toggleMoreMenu(false); } });
  el.saveKey.addEventListener('click', () => {
    const key = el.apiKey.value.trim();
    if (!key) return;
    el.connMsg.textContent = 'Saving…';
    el.connMsg.className = 'hint';
    vscode.postMessage({ kind: 'saveApiKey', apiKey: key });
    el.apiKey.value = '';
  });
  el.test.addEventListener('click', () => {
    el.connMsg.textContent = 'Pinging Techword API…';
    el.connMsg.className = 'hint';
    if (el.connDot) el.connDot.className = 'conn-dot pending';
    if (el.connLatency) el.connLatency.textContent = '';
    if (el.connModels) { el.connModels.className = 'conn-models hidden'; el.connModels.textContent = ''; }
    vscode.postMessage({ kind: 'testConnection' });
  });
  el.disconnect.addEventListener('click', () => vscode.postMessage({ kind: 'disconnect' }));
  el.modelSelect.addEventListener('change', () => vscode.postMessage({ kind: 'selectModel', model: el.modelSelect.value }));
  el.settingsModel.addEventListener('change', () => vscode.postMessage({ kind: 'selectModel', model: el.settingsModel.value }));
  el.autoEdits.addEventListener('change', sendAutoApprove);
  el.autoCommands.addEventListener('change', sendAutoApprove);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || !m.kind) return;
    switch (m.kind) {
      case 'state': applyState(m); break;
      case 'delta': appendDelta(m.text); break;
      case 'thinking': feedThinking(m.text); break; // real reasoning stream → Activity transcript
      case 'resetStream':
        // A turn dropped mid-reply and is being retried; discard the half-streamed bubble so the
        // re-sent text doesn't appear twice.
        if (currentAssistant) { currentAssistant.remove(); }
        currentAssistant = null; currentRaw = ''; renderScheduled = false; resetThinking();
        break;
      case 'status':
        // Generic "Working…" keeps the lively rotation going; a specific status replaces it.
        if (/^working[.…]*$/i.test(m.message)) { if (!statusTimer) { rotateThinking(); } }
        else { stopThinking(); showStatus(m.message); pinWork(m.message); logActivity(m.message); }
        break;
      case 'tool': addTool(m.name, m.detail); break;
      case 'commandOutput': addCommandOutput(m.chunk); break;
      case 'toolResult': addToolResult(m.summary); break;
      case 'checkpoint': addCheckpoint(m.id, m.summary); logActivity('✓ Applied: ' + (m.summary || 'changes'), 'tr-done'); break;
      case 'question': waitingForAnswer = true; addQuestion(m.text, m.options); break;
      case 'queued': renderQueued(m.items); break;
      case 'preview': addPreview(m.dataUrl, m.name); break;
      case 'error': waitingForAnswer = false; setBusy(false); renderQueued([]); addError(m.message); logActivity(m.message, 'tr-error'); armActivityClear(); break;
      case 'complete': waitingForAnswer = false; endAssistant(); clearStatus(); setBusy(false); renderQueued([]); logActivity('Done.', 'tr-done'); armActivityClear(); break;
      case 'cmdResult': showCmdResult(m.token, m.output, m.failed); break; // faded terminal output under a Run button
      case 'approvalRequest': addApproval(m.request, m.auto, m.warning); break;
      case 'approvalResolved': resolveApproval(m.id, m.approved); break;
      case 'usage': renderUsage(m); updateContextRing(m.window, m.limit); break;
      case 'compacted': addNote('↺ ' + m.message); break;
      case 'attachments': renderAttachments(m.items); break;
      case 'history': renderHistory(m.items, m.currentId); break;
      case 'renamed': document.title = m.title; addNote('✎ Renamed to "' + m.title + '"'); break;
      case 'load': loadDisplay(m.title, m.items); break;
      case 'connection':
        el.connMsg.textContent = m.message;
        el.connMsg.className = 'hint ' + (m.ok ? 'ok' : 'err');
        if (el.connDot) el.connDot.className = 'conn-dot ' + (m.ok ? 'alive' : 'dead');
        if (el.connLatency) {
          // Latency in ms, colour-graded: <800ms snappy (green), <2s ok (amber), slower = red.
          if (m.ok && typeof m.latencyMs === 'number') {
            var grade = m.latencyMs < 800 ? 'fast' : (m.latencyMs < 2000 ? 'mid' : 'slow');
            el.connLatency.textContent = m.latencyMs + ' ms';
            el.connLatency.className = 'conn-latency ' + grade;
          } else {
            el.connLatency.textContent = '';
            el.connLatency.className = 'conn-latency';
          }
        }
        if (el.connModels) {
          if (m.ok && Array.isArray(m.models) && m.models.length) {
            el.connModels.textContent = '';
            var head = document.createElement('div');
            head.className = 'conn-models-head';
            head.textContent = 'Available models (' + m.models.length + ')';
            el.connModels.appendChild(head);
            m.models.forEach(function (name) {
              var chip = document.createElement('span');
              chip.className = 'conn-model-chip';
              chip.textContent = name;
              el.connModels.appendChild(chip);
            });
            el.connModels.className = 'conn-models';
          } else {
            el.connModels.className = 'conn-models hidden';
            el.connModels.textContent = '';
          }
        }
        break;
    }
  });

  vscode.postMessage({ kind: 'getState' });
})();
