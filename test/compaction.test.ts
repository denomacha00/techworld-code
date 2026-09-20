import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseCompactionCut } from '../src/agent/AgentSession';

// The compacted history is [system, ...messages.slice(cut)] with the summary folded into messages[cut].
// For that to be a valid Anthropic request, cut MUST land on a real 'user' turn: the kept tail then
// starts with a user message and no assistant tool_use is split from its tool_result.

test('cut lands on a real user turn near the tail', () => {
  // system, user, assistant, tool, assistant, user, assistant
  const roles = ['system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant'];
  const cut = chooseCompactionCut(roles, 4);
  assert.equal(roles[cut], 'user');
  assert.ok(cut >= 2, 'there must be older history to summarize');
});

test('never cuts between an assistant tool_use and its tool_result', () => {
  // The tail is one tool round: cutting at index 3 or 4 would orphan a tool_result. Only index 5 (user) is valid.
  const roles = ['system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool'];
  const cut = chooseCompactionCut(roles, 3);
  assert.equal(roles[cut], 'user');
});

test('falls back to a later user boundary when none sits at/before the target', () => {
  // Long tool chain then a fresh user turn late; target lands mid-chain, so we must scan forward to the user.
  const roles = ['system', 'user', 'assistant', 'tool', 'tool', 'assistant', 'tool', 'user', 'assistant'];
  const cut = chooseCompactionCut(roles, 4);
  assert.equal(roles[cut], 'user');
  assert.equal(cut, 7);
});

test('returns -1 when there is no safe user boundary to cut at', () => {
  // One giant user turn with only tool rounds after it — no later user message to cut on.
  const roles = ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'];
  assert.equal(chooseCompactionCut(roles, 4), -1);
});

test('returns -1 when history is too short to compact', () => {
  assert.equal(chooseCompactionCut(['system', 'user'], 4), -1);
  assert.equal(chooseCompactionCut(['system'], 4), -1);
});
