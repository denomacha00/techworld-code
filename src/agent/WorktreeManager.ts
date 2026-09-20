import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 60000;
const MAX_BUFFER = 64 * 1024 * 1024; // big diffs / file lists on large repos

/** One file the worker changed inside its worktree, relative to the repo root (forward slashes).
 *  content === null means the worker deleted it. */
export interface WorktreeChange { path: string; content: string | null; }

/** A live worktree handed to a worker agent. */
export interface Worktree { dir: string; base: string; }

/**
 * Creates throw-away git worktrees so parallel worker agents can EDIT and TEST in real isolation —
 * each on its own checkout — then hands their net changes back for the main agent to integrate into the
 * real workspace (never a blind git merge). This is the "agents get their own worktree, main integrates"
 * model: workers never touch the user's files directly, so several can edit at once with no clobbering.
 *
 * A worktree is seeded to match the main tree's CURRENT state (HEAD + the user's uncommitted tracked
 * edits, replayed in) so a worker reasons about the code as it actually is, and integrating a worker's
 * result back never silently reverts the user's own in-progress edits (those survive because we write
 * each changed file's full final content, and files the worker didn't touch are filtered out).
 *
 * Pure Node (execFile + fs), so it is unit-testable without VS Code.
 */
export class WorktreeManager {
  constructor(private readonly repoRoot: string) {}

  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: cwd ?? this.repoRoot, timeout: GIT_TIMEOUT, windowsHide: true, maxBuffer: MAX_BUFFER });
    return stdout;
  }

  /** git worktrees need a repo WITH at least one commit (a HEAD to branch from). Both are required. */
  async isUsable(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--is-inside-work-tree']);
      await this.git(['rev-parse', 'HEAD']); // fails on an empty repo with no commits
      return true;
    } catch { return false; }
  }

  /** Create an isolated worktree seeded from the main tree's current state. Detached (no branch) so
   *  there's nothing to clean up but the directory itself. */
  async create(): Promise<Worktree> {
    const id = randomUUID().slice(0, 8);
    const dir = path.join(os.tmpdir(), `techword-wt-${id}`);
    const base = (await this.git(['rev-parse', 'HEAD'])).trim();
    await this.git(['worktree', 'add', '--detach', dir, base]);
    // Replay the main tree's uncommitted TRACKED edits into the fresh checkout so the worker sees the
    // code as it is right now, not just the last commit. Best-effort: if the patch doesn't apply
    // cleanly (rare — binary/rename edge cases), the worker simply works from HEAD instead.
    try {
      const diff = await this.git(['diff', 'HEAD']);
      if (diff.trim()) { await this.apply(dir, diff); }
    } catch { /* worker works from HEAD */ }
    return { dir, base };
  }

  /** Pipe a unified diff into `git apply` inside the worktree (stdin, so no temp file to clean up). */
  private apply(dir: string, diff: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['apply', '--whitespace=nowarn'], { cwd: dir, windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `git apply exited ${code}`)));
      child.stdin.end(diff);
    });
  }

  /**
   * The worker's net changes vs the base commit: every file it added, modified, or deleted (whether it
   * committed inside the worktree or just left working-tree edits), plus new untracked files. Deleted
   * files come back with content null. Paths are repo-relative with forward slashes.
   */
  async captureChanges(wt: Worktree): Promise<WorktreeChange[]> {
    const changes = new Map<string, WorktreeChange>();
    // Tracked changes vs the base commit (covers both committed and uncommitted worker edits).
    const nameStatus = await this.git(['diff', wt.base, '--name-status', '-z', '--find-renames'], wt.dir);
    for (const entry of parseNameStatusZ(nameStatus)) {
      if (entry.status === 'D') { changes.set(entry.path, { path: entry.path, content: null }); }
      else { changes.set(entry.path, { path: entry.path, content: await this.readFile(wt.dir, entry.path) }); }
    }
    // New untracked files the worker created (respecting .gitignore).
    const untracked = await this.git(['ls-files', '--others', '--exclude-standard', '-z'], wt.dir);
    for (const rel of untracked.split('\0').map((s) => s.trim()).filter(Boolean)) {
      const norm = rel.replace(/\\/g, '/');
      if (!changes.has(norm)) { changes.set(norm, { path: norm, content: await this.readFile(wt.dir, norm) }); }
    }
    return [...changes.values()];
  }

  /** A short, human-readable summary of what the worker changed (for the main agent's context). */
  async diffStat(wt: Worktree): Promise<string> {
    try { return (await this.git(['diff', wt.base, '--stat', '--find-renames'], wt.dir)).trim(); }
    catch { return ''; }
  }

  private async readFile(dir: string, rel: string): Promise<string | null> {
    try { return await fs.readFile(path.join(dir, rel), 'utf8'); }
    catch { return null; } // unreadable/binary → skip by treating as no content
  }

  /** Tear the worktree down. Best-effort: force-remove, then prune the admin entry. */
  async remove(wt: Worktree): Promise<void> {
    try { await this.git(['worktree', 'remove', '--force', wt.dir]); }
    catch {
      try { await fs.rm(wt.dir, { recursive: true, force: true }); } catch { /* already gone */ }
      try { await this.git(['worktree', 'prune']); } catch { /* ignore */ }
    }
  }
}

/** Parse `git diff --name-status -z` output. Rename/copy entries carry two paths; we key on the NEW path
 *  (M/A/D use one path). Exported for unit tests. */
export function parseNameStatusZ(z: string): Array<{ status: 'A' | 'M' | 'D' | 'R'; path: string }> {
  const tokens = z.split('\0').filter((t) => t.length > 0);
  const out: Array<{ status: 'A' | 'M' | 'D' | 'R'; path: string }> = [];
  for (let i = 0; i < tokens.length; ) {
    const code = (tokens[i] ?? '').trim();
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      // R<score>\0<old>\0<new> — the destination is what now exists in the worktree.
      const newPath = tokens[i + 2];
      if (newPath) { out.push({ status: 'R', path: newPath.replace(/\\/g, '/') }); }
      i += 3;
    } else if (letter === 'A' || letter === 'M' || letter === 'D') {
      const p = tokens[i + 1];
      if (p) { out.push({ status: letter, path: p.replace(/\\/g, '/') }); }
      i += 2;
    } else {
      i += 1; // unknown/empty — skip defensively
    }
  }
  return out;
}
