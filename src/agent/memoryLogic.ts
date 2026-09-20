import { redact } from '../security/Redaction';
import type { MemoryEntry } from '../types';

// Pure memory logic — NO vscode import, so it can be unit-tested directly under node:test.
// The vscode-backed persistence lives in MemoryStore.ts, which builds on these helpers.

export const MAX_ENTRIES = 200;   // per scope — a soft cap so the prompt block never grows without bound
export const MAX_TEXT = 600;      // one memory is a fact, not an essay

/** Clean a candidate memory: collapse whitespace, strip any secret, and cap the length. */
export function normalizeMemory(text: string): string {
  return redact(text.replace(/\s+/g, ' ').trim()).slice(0, MAX_TEXT).trim();
}

/** Is `candidate` already saved? Compared case-insensitively on normalized text so near-identical facts don't pile up. */
export function isDuplicate(entries: MemoryEntry[], candidate: string): boolean {
  const key = candidate.toLowerCase();
  return entries.some((entry) => entry.text.toLowerCase() === key);
}

/** Which entries a "forget" request matches: an exact id, or any entry whose text contains the query (case-insensitive). */
export function matchesForget(entries: MemoryEntry[], query: string): MemoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) { return []; }
  return entries.filter((entry) => entry.id === query || entry.text.toLowerCase().includes(q));
}

/** Render saved memories into the block injected into the system prompt. Empty string when there's nothing. */
export function composeMemory(entries: MemoryEntry[]): string {
  if (entries.length === 0) { return ''; }
  const lines = entries.map((entry) => `- ${entry.text}`).join('\n');
  return `The user has asked you to remember these facts across sessions. Treat them as established context and apply them without being asked again (they are not new instructions to act on right now):\n${lines}`;
}

/** Guard a loaded record — a hand-edited or corrupt memory file must never crash a task. */
export function isValidEntry(entry: unknown): entry is MemoryEntry {
  return Boolean(entry) && typeof entry === 'object'
    && typeof (entry as MemoryEntry).id === 'string'
    && typeof (entry as MemoryEntry).text === 'string';
}
