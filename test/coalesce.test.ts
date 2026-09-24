import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalesceMessages } from '../src/providers/OpenAICompatibleClient';

// Anthropic rejects two same-role turns in a row (400 "roles must alternate"). Our history legitimately
// produces adjacent user turns — a run of tool_results is one user turn, and a queued follow-up that ripens
// right behind it (or two follow-ups at once) appends more. coalesceMessages merges them so the follow-up
// can't kill the task with a 400. These tests pin that behavior.

test('adjacent user turns (tool_result then text) merge into one user turn, order preserved', () => {
  const out = coalesceMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    { role: 'user', content: 'a follow-up message that arrived mid-run' },
  ] as never);
  assert.equal(out.length, 2, 'assistant + one merged user turn');
  assert.equal(out[0]!.role, 'assistant');
  assert.equal(out[1]!.role, 'user');
  const parts = out[1]!.content as Array<{ type: string }>;
  assert.equal(parts.length, 2);
  assert.equal(parts[0]!.type, 'tool_result');
  assert.equal(parts[1]!.type, 'text');
});

test('several adjacent user text turns collapse into one', () => {
  const out = coalesceMessages([
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second' },
    { role: 'user', content: 'third' },
  ] as never);
  assert.equal(out.length, 1);
  assert.equal((out[0]!.content as unknown[]).length, 3);
});

test('proper alternation is left untouched', () => {
  const msgs = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'q2' },
  ];
  const out = coalesceMessages(msgs as never);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('adjacent assistant turns merge too (defensive — should be rare)', () => {
  const out = coalesceMessages([
    { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
  ] as never);
  assert.equal(out.length, 1);
  assert.equal((out[0]!.content as unknown[]).length, 2);
});

test('the input array is not mutated', () => {
  const input = [
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
  ];
  const before = JSON.stringify(input);
  coalesceMessages(input as never);
  assert.equal(JSON.stringify(input), before, 'coalesce must be pure');
});
