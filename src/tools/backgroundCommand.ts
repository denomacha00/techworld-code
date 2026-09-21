// Pure helpers for background-command bookkeeping. No vscode / no child_process here, so this logic is
// unit-testable on its own (the actual spawning + process-tree killing stays in WorkspaceToolExecutor).
//
// Background commands exist because a foreground command blocks the agent and can't outlive a turn — so a
// long build (PyInstaller) or a dev server could never finish. These functions format what the model sees
// when it polls, and cap the retained output so a chatty long-running process can't grow memory forever.

/** The bookkeeping fields of a background process the pure helpers need (no live child handle). */
export interface BackgroundState {
  token: string;
  command: string;
  output: string;
  exitCode: number | undefined;
  running: boolean;
  startedAt: number;
  endedAt: number | undefined;
}

/** Append `piece` to a process's output, keeping only the LAST `cap` chars (a tail ring buffer). Prevents
 *  an endless dev server / verbose build from growing the buffer without bound. */
export function appendCapped(existing: string, piece: string, cap: number): string {
  const combined = existing + piece;
  return combined.length > cap ? combined.slice(-cap) : combined;
}

/** Human/model-readable status line for a background process, given the current time. */
export function describeBackgroundStatus(proc: Pick<BackgroundState, 'running' | 'exitCode' | 'startedAt' | 'endedAt'>, now: number): string {
  const elapsed = Math.max(0, Math.round(((proc.endedAt ?? now) - proc.startedAt) / 1000));
  return proc.running ? `RUNNING (${elapsed}s so far)` : `EXITED (code ${proc.exitCode ?? 'unknown'}, ran ${elapsed}s)`;
}

/** The full poll report the model gets from check_background_command (before redaction/length-capping). */
export function formatBackgroundReport(proc: BackgroundState, now: number): string {
  const status = describeBackgroundStatus(proc, now);
  const body = proc.output.trim() || '(no output yet)';
  const tip = proc.running ? '\n\n(Still running — keep working and check again later, or stop_background_command to end it.)' : '';
  return `[background ${proc.token}] ${proc.command}\nStatus: ${status}\n\n${body}${tip}`;
}

/** Message when a token doesn't match any tracked process — lists the tokens that DO exist so the model
 *  can recover instead of guessing. */
export function unknownTokenMessage(token: string, knownTokens: readonly string[]): string {
  return knownTokens.length
    ? `No background command with token "${token}". Active/finished tokens: ${knownTokens.join(', ')}.`
    : `No background command with token "${token}", and none are running.`;
}
