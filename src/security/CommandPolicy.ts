// Classifies a proposed shell command so Techword Code can run safely on its own overnight:
//  - 'blocked'  genuinely dangerous / irreversible or exfiltrating — NEVER auto-run, even when the
//               user turned on auto-approve. Still shown; the human must click.
//  - 'safe'     read-only inspection (ls, cat, git status, test/build) — fine to auto-run.
//  - 'caution'  everything else (writes, installs) — auto-run only if the user enabled auto-approve.
// Pure and dependency-free so it is unit-tested directly.

export type CommandLevel = 'safe' | 'caution' | 'blocked';
export interface CommandVerdict { level: CommandLevel; reason?: string; }

// Patterns that are destructive, hard to reverse, or send data/credentials off the machine.
// Kept deliberately broad — when unsure we escalate to a human, we don't silently run.
const DANGEROUS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f|\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*r/i, reason: 'recursive force delete (rm -rf)' },
  { re: /\brm\s+(-[a-z]*\s+)*(\/|~|\$HOME|\*)(\s|$)/i, reason: 'delete of a root/home/wildcard path' },
  { re: /\b(rmdir|rd)\s+\/s\b/i, reason: 'recursive directory delete' },
  { re: /\bdel\s+\/[sfq]/i, reason: 'recursive/forced delete' },
  { re: /\bformat\b|\bmkfs\b|\bdiskpart\b/i, reason: 'disk format' },
  { re: /\bdd\b[^|]*\bof=\/dev\//i, reason: 'raw write to a device (dd)' },
  { re: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: 'write to a raw disk device' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: 'fork bomb' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'shuts down or reboots the machine' },
  { re: /\bgit\s+push\b[^\n]*\s(--force|-f)\b/i, reason: 'force push (rewrites remote history)' },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: 'hard reset (discards local work)' },
  { re: /\bgit\s+clean\s+(-[a-z]*\s+)*-[a-z]*f/i, reason: 'git clean -f (deletes untracked files)' },
  { re: /\bchmod\s+(-R\s+)?0*777\b/i, reason: 'world-writable permissions' },
  { re: /\bchmod\s+-R\b.*\//i, reason: 'recursive permission change on a path' },
  { re: /\b(curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python|node|pwsh|powershell)\b/i, reason: 'pipes a downloaded script straight into a shell' },
  { re: /\bsudo\b/i, reason: 'runs as administrator (sudo)' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, reason: 'publishes a package to a public registry' },
  // NOTE: a plain `git push` is deliberately NOT blocked — it is a routine action that must run
  // fluently in Bypass/auto-approve mode. Only history-rewriting force push (above) is blocked. A
  // normal push falls through to `caution`, so it auto-runs when the user enabled command auto-approve
  // and still asks in Manual mode. Blocking every push made Bypass mode ask on every `git push`.
  { re: /\b(scp|rsync)\b[^\n]*@/i, reason: 'copies files to a remote host' },
  { re: /\bnc\b\s+-|\bnetcat\b/i, reason: 'raw network connection (netcat)' }
];

// Read-only inspection commands that are safe to run unattended. NOTE: language runtimes that execute
// arbitrary code (node, python, go run, cargo run, ruby, deno, bun as a script host) are deliberately
// NOT here — `node -e "…"` / `python -c "…"` can do anything, so they fall through to `caution` and are
// gated unless the user turned auto-approve on. Only genuinely read-only inspectors are listed.
const SAFE_LEADERS = new Set(['ls', 'dir', 'pwd', 'cat', 'less', 'more', 'head', 'tail', 'echo', 'type', 'find', 'grep', 'rg', 'ag', 'fd', 'wc', 'stat', 'file', 'which', 'where', 'whoami', 'date', 'env', 'printenv', 'tree', 'du', 'df', 'ps', 'tsc', 'eslint']);
const SAFE_GIT_SUB = new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'describe', 'blame', 'ls-files', 'config']);
// A test/build/type-check invocation is safe to run unattended (that's the verify loop).
const SAFE_SCRIPTS = /\b(test|build|lint|typecheck|type-check|check|tsc|jest|vitest|mocha|pytest|coverage)\b/i;

/** Classify one command string. When several are chained, the most severe verdict wins. */
export function classifyCommand(command: string, extraBlocked: string[] = []): CommandVerdict {
  const text = command.trim();
  if (!text) { return { level: 'caution' }; }

  for (const pattern of extraBlocked) {
    if (!pattern.trim()) { continue; }
    try { if (new RegExp(pattern, 'i').test(text)) { return { level: 'blocked', reason: `matches a blocked-command rule (${pattern})` }; } }
    catch { if (text.toLowerCase().includes(pattern.toLowerCase())) { return { level: 'blocked', reason: `contains a blocked term (${pattern})` }; } }
  }
  for (const { re, reason } of DANGEROUS) {
    if (re.test(text)) { return { level: 'blocked', reason }; }
  }
  // Second pass: catch the SAME dangerous rm/git/chmod actions written in a form the regexes above miss
  // (split flags `rm -r -f /`, long flags `rm --recursive --force`, git global options `git -C d reset
  // --hard`, combined `chmod -Rf 777`, setuid `chmod 4777`). Parsed per-segment. Purely additive — it can
  // only ADD a 'blocked' verdict the regex pass didn't already give, never downgrade one.
  const parsed = dangerousByParse(text);
  if (parsed) { return { level: 'blocked', reason: parsed }; }

  // Split on chaining/pipes so `git status && rm ...` is judged by its worst part.
  const segments = text.split(/&&|\|\||[;|]/).map((seg) => seg.trim()).filter(Boolean);
  let allSafe = segments.length > 0;
  for (const segment of segments) {
    if (!isSafeSegment(segment)) { allSafe = false; }
  }
  return { level: allSafe ? 'safe' : 'caution' };
}

function isSafeSegment(segment: string): boolean {
  const tokens = segment.split(/\s+/);
  const leader = (tokens[0] ?? '').toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
  if (!leader) { return false; }
  if ((leader === 'npm' || leader === 'pnpm' || leader === 'yarn' || leader === 'bun') && (tokens[1] === 'run' || tokens[1] === 'test' || tokens[1] === 'run-script') && SAFE_SCRIPTS.test(segment)) { return true; }
  if ((leader === 'npx' || leader === 'pnpm' || leader === 'bunx') && SAFE_SCRIPTS.test(segment)) { return true; } // npx tsc / eslint / jest …
  if (leader === 'git') { const sub = (tokens[1] ?? '').toLowerCase(); return SAFE_GIT_SUB.has(sub); }
  if (SAFE_LEADERS.has(leader) && !/[>]/.test(segment)) { return true; } // no output redirection
  return false;
}

/** Parse-based danger detection for rm/git/chmod, run per chained segment. Catches syntactic variants the
 *  broad DANGEROUS regexes miss. Returns a reason (→ blocked) or undefined. */
function dangerousByParse(text: string): string | undefined {
  const segments = text.split(/&&|\|\||[;|]/).map((seg) => seg.trim()).filter(Boolean);
  for (const seg of segments) {
    const reason = dangerousRm(seg) ?? dangerousGit(seg) ?? dangerousChmod(seg);
    if (reason) { return reason; }
  }
  return undefined;
}

/** rm is dangerous when it's recursive AND forced (any flag spelling), or targets a root/home/wildcard
 *  path. Handles `-rf`, `-r -f`, `-fr`, `--recursive --force`, and `-R`. */
function dangerousRm(seg: string): string | undefined {
  const tokens = seg.split(/\s+/).filter(Boolean);
  const idx = tokens.findIndex((t) => t.toLowerCase().replace(/\.exe$/i, '') === 'rm');
  if (idx === -1) { return undefined; }
  let recursive = false; let force = false; const targets: string[] = [];
  for (const tok of tokens.slice(idx + 1)) {
    if (tok === '--') { continue; }
    if (tok === '--recursive') { recursive = true; continue; }
    if (tok === '--force') { force = true; continue; }
    if (tok.startsWith('--')) { continue; }                 // other long option (--verbose, --dir…)
    if (tok.startsWith('-') && tok.length > 1) { if (/r/i.test(tok)) { recursive = true; } if (/f/.test(tok)) { force = true; } continue; }
    targets.push(tok);
  }
  if (recursive && force) { return 'recursive force delete (rm -rf)'; }
  if (targets.some((t) => /^(\/|~|\$HOME|\*)$/.test(t) || /^(\/|~|\$HOME)\/?\*?$/.test(t))) { return 'delete of a root/home/wildcard path'; }
  return undefined;
}

/** git is dangerous for force push, hard reset, or clean -f — even behind global options like `-C dir`,
 *  `-c k=v`, or `--git-dir=…` that sit between `git` and the subcommand. */
function dangerousGit(seg: string): string | undefined {
  const tokens = seg.split(/\s+/).filter(Boolean);
  const idx = tokens.findIndex((t) => t.toLowerCase().replace(/\.exe$/i, '') === 'git');
  if (idx === -1) { return undefined; }
  let i = idx + 1;
  const takesArg = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);
  while (i < tokens.length) {
    const t = tokens[i] ?? '';
    if (takesArg.has(t)) { i += 2; continue; }              // option consumes the next token as its value
    if (t.startsWith('-')) { i += 1; continue; }            // flag global option incl. --opt=value, --paginate, --bare
    break;
  }
  const sub = (tokens[i] ?? '').toLowerCase();
  const rest = tokens.slice(i + 1);
  if (sub === 'push' && rest.some((t) => /^--force/.test(t) || t === '-f')) { return 'force push (rewrites remote history)'; }
  if (sub === 'reset' && rest.some((t) => t === '--hard')) { return 'hard reset (discards local work)'; }
  if (sub === 'clean' && rest.some((t) => t === '--force' || /^-[a-z]*f/i.test(t))) { return 'git clean -f (deletes untracked files)'; }
  return undefined;
}

/** chmod is dangerous when it grants world-write-all (mode ending in 777, incl. setuid forms like 4777),
 *  or recursively changes permissions on a filesystem path. Handles combined flags like `-Rf`. */
function dangerousChmod(seg: string): string | undefined {
  const tokens = seg.split(/\s+/).filter(Boolean);
  const idx = tokens.findIndex((t) => t.toLowerCase() === 'chmod');
  if (idx === -1) { return undefined; }
  let recursive = false; const operands: string[] = [];
  for (const tok of tokens.slice(idx + 1)) {
    if (tok === '--recursive') { recursive = true; continue; }
    if (tok.startsWith('-') && tok.length > 1) { if (/r/i.test(tok)) { recursive = true; } continue; }
    operands.push(tok);
  }
  const mode = operands[0] ?? '';
  const octal = /^[0-7]{3,4}$/.test(mode) ? mode.slice(-3) : '';
  if (octal === '777') { return 'world-writable permissions'; }
  if (recursive && operands.slice(1).some((t) => t.includes('/') || t === '~' || t.startsWith('~/'))) { return 'recursive permission change on a path'; }
  return undefined;
}

/** How a proposed tool action is handled BEFORE any UI, given the current auto-approve policy and (for
 *  commands) how dangerous it is: run it now, ASK the user (park a card to click), or REJECT it outright.
 *  The subtle rule is the last one. In Bypass the user opted into an UNATTENDED run, so a 'blocked'
 *  (catastrophic) command must never auto-RUN — but parking it for a click that may never come (panel
 *  closed, overnight) is exactly the hang the user reported. So it is REJECTED and the run continues;
 *  attended Manual/Edit modes (autoRun=false) still ASK, preserving the "human clicks" safety net there. */
export type ApprovalDecision = 'auto' | 'ask' | 'reject';
export function approvalDecision(input: { autoRun: boolean; blocked: boolean }): ApprovalDecision {
  if (input.blocked) { return input.autoRun ? 'reject' : 'ask'; }
  return input.autoRun ? 'auto' : 'ask';
}
