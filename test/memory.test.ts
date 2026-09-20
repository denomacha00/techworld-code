import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemory, isDuplicate, matchesForget, composeMemory } from '../src/agent/memoryLogic';
import type { MemoryEntry } from '../src/types';

const entry = (id: string, text: string): MemoryEntry => ({ id, text, scope: 'project', createdAt: 0 });

test('normalizeMemory collapses whitespace and trims', () => {
  assert.equal(normalizeMemory('  the   user  prefers\n\ttabs  '), 'the user prefers tabs');
});

test('normalizeMemory strips secrets — memory can be shared with a team', () => {
  const cleaned = normalizeMemory('the deploy key is sk-EXAMPLEfakeKEY0000000000000000000000');
  assert.ok(cleaned.includes('[REDACTED]'), 'an API key must never be persisted verbatim');
  assert.ok(!/sk-EXAMPLEfakeKEY0000000000000000000000/.test(cleaned));
});

test('normalizeMemory caps runaway length (a memory is a fact, not an essay)', () => {
  assert.ok(normalizeMemory('x'.repeat(5000)).length <= 600);
});

test('normalizeMemory returns empty for blank input (nothing to save)', () => {
  assert.equal(normalizeMemory('   \n  '), '');
});

test('isDuplicate is case-insensitive so near-identical facts do not pile up', () => {
  const entries = [entry('1', 'Uses pnpm, not npm')];
  assert.equal(isDuplicate(entries, 'uses pnpm, not npm'), true);
  assert.equal(isDuplicate(entries, 'Prefers 2-space indent'), false);
});

test('matchesForget finds by exact id or by substring, and ignores blanks', () => {
  const entries = [entry('abc', 'Deploys on Fridays'), entry('def', 'Runs tests with vitest')];
  assert.deepEqual(matchesForget(entries, 'abc').map((e) => e.id), ['abc']);
  assert.deepEqual(matchesForget(entries, 'vitest').map((e) => e.id), ['def']);
  assert.deepEqual(matchesForget(entries, 'FRIDAY').map((e) => e.id), ['abc']);
  assert.deepEqual(matchesForget(entries, '   '), []);
});

test('composeMemory renders a labelled block, and stays empty when there is nothing', () => {
  assert.equal(composeMemory([]), '');
  const block = composeMemory([entry('1', 'Uses pnpm'), entry('2', 'Prefers TypeScript')]);
  assert.ok(block.includes('- Uses pnpm'));
  assert.ok(block.includes('- Prefers TypeScript'));
  // It must frame memories as established context, not fresh instructions to act on right now.
  assert.ok(/remember|established context/i.test(block));
});
