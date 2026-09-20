import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { MemoryEntry, MemoryScope } from '../types';
import { MAX_ENTRIES, composeMemory, isDuplicate, isValidEntry, matchesForget, normalizeMemory } from './memoryLogic';

// Pure, unit-tested helpers live in ./memoryLogic (no vscode). Re-export them so callers still have a
// single import surface, and the store below adds the vscode-backed persistence.
export { normalizeMemory, isDuplicate, matchesForget, composeMemory } from './memoryLogic';

const GLOBAL_KEY = 'techwordCode.memory.global';
const PROJECT_FILE = ['.techword', 'memory.json'];

interface MemoryFile { version: 1; entries: MemoryEntry[]; }

// ---------- store ----------

/**
 * Durable, cross-session memory — the thing that makes Techword Code carry facts forward like a
 * human collaborator. Project memory lives in `.techword/memory.json` (travels with the repo, so a
 * team shares it and the user can hand-edit it); global memory lives in globalState (follows the
 * user across every workspace). Secrets are redacted before anything is written to disk.
 */
export class MemoryStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** All memories, project first then global, most-recent last within each scope. */
  async list(): Promise<MemoryEntry[]> {
    const project = await this.readProject();
    const global = this.readGlobal();
    return [...project, ...global];
  }

  /** The block for the system prompt. Never throws — memory must not break a task. */
  async compose(): Promise<string> {
    try { return composeMemory(await this.list()); } catch { return ''; }
  }

  /** Scope to use when the caller didn't specify one: project when a workspace is open, else global. */
  defaultScope(): MemoryScope {
    return vscode.workspace.workspaceFolders?.[0] ? 'project' : 'global';
  }

  /** Save a fact. Returns the outcome so the caller can tell the model/user what happened. */
  async remember(text: string, scope?: MemoryScope): Promise<{ saved: boolean; reason?: string; entry?: MemoryEntry }> {
    const clean = normalizeMemory(text);
    if (!clean) { return { saved: false, reason: 'empty' }; }
    const target: MemoryScope = scope ?? this.defaultScope();
    const entries = target === 'project' ? await this.readProject() : this.readGlobal();
    if (isDuplicate(entries, clean)) { return { saved: false, reason: 'duplicate' }; }
    const entry: MemoryEntry = { id: randomUUID(), text: clean, scope: target, createdAt: Date.now() };
    const next = [...entries, entry].slice(-MAX_ENTRIES);
    await this.write(target, next);
    return { saved: true, entry };
  }

  /** Remove every memory matching a query (id or substring), across both scopes. Returns how many went. */
  async forget(query: string): Promise<number> {
    let removed = 0;
    for (const scope of ['project', 'global'] as MemoryScope[]) {
      const entries = scope === 'project' ? await this.readProject() : this.readGlobal();
      const kept = entries.filter((entry) => !matchesForget([entry], query).length);
      if (kept.length !== entries.length) { removed += entries.length - kept.length; await this.write(scope, kept); }
    }
    return removed;
  }

  /** Delete one memory by id (from the management UI). */
  async deleteById(id: string): Promise<boolean> {
    for (const scope of ['project', 'global'] as MemoryScope[]) {
      const entries = scope === 'project' ? await this.readProject() : this.readGlobal();
      const kept = entries.filter((entry) => entry.id !== id);
      if (kept.length !== entries.length) { await this.write(scope, kept); return true; }
    }
    return false;
  }

  /** Replace the text of one memory by id (from the management UI). */
  async editById(id: string, text: string): Promise<boolean> {
    const clean = normalizeMemory(text);
    if (!clean) { return false; }
    for (const scope of ['project', 'global'] as MemoryScope[]) {
      const entries = scope === 'project' ? await this.readProject() : this.readGlobal();
      const entry = entries.find((item) => item.id === id);
      if (entry) { entry.text = clean; await this.write(scope, entries); return true; }
    }
    return false;
  }

  /** Wipe a whole scope (or everything). */
  async clear(scope?: MemoryScope): Promise<void> {
    if (!scope || scope === 'project') { await this.write('project', []); }
    if (!scope || scope === 'global') { await this.write('global', []); }
  }

  // ---------- persistence ----------

  private readGlobal(): MemoryEntry[] {
    const raw = this.context.globalState.get<MemoryEntry[]>(GLOBAL_KEY, []);
    return Array.isArray(raw) ? raw.filter(isValidEntry).map((entry) => ({ ...entry, scope: 'global' as const })) : [];
  }

  private async readProject(): Promise<MemoryEntry[]> {
    const uri = this.projectUri();
    if (!uri) { return []; }
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(data).toString('utf8')) as Partial<MemoryFile>;
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      return entries.filter(isValidEntry).map((entry) => ({ ...entry, scope: 'project' as const }));
    } catch { return []; /* not present or unreadable — no memory yet */ }
  }

  private async write(scope: MemoryScope, entries: MemoryEntry[]): Promise<void> {
    if (scope === 'global') { await this.context.globalState.update(GLOBAL_KEY, entries); return; }
    const uri = this.projectUri();
    if (!uri) { return; } // no workspace: project memory has nowhere to live
    const dir = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, PROJECT_FILE[0]!);
    try { await vscode.workspace.fs.createDirectory(dir); } catch { /* already exists */ }
    const file: MemoryFile = { version: 1, entries };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(file, null, 2), 'utf8'));
  }

  private projectUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, ...PROJECT_FILE) : undefined;
  }
}
