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
