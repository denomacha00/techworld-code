import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSystemCacheBreakpoint, withToolsCacheBreakpoint, withMessageCacheBreakpoint, isCacheRejection } from '../src/providers/OpenAICompatibleClient';

// Prompt caching is the biggest speed/cost lever after disabling hidden thinking: a cache READ is ~10×
// cheaper and much faster to first byte than reprocessing the tools + system + history every turn. These
// tests guard the two invariants that make it safe: (1) the shared TOOLS constant is NEVER mutated (a
// leaked cache_control would poison every future request), and (2) a gateway that can't do it degrades.

test('system string becomes a single cacheable text block', () => {
  const out = withSystemCacheBreakpoint('You are Techword Code.');
  assert.deepEqual(out, [{ type: 'text', text: 'You are Techword Code.', cache_control: { type: 'ephemeral' } }]);
});

test('tools: only the LAST definition is tagged, and the input array is never mutated', () => {
  const tools = [{ name: 'read_file' }, { name: 'edit_file' }];
  const frozenCopy = JSON.parse(JSON.stringify(tools));
  const out = withToolsCacheBreakpoint(tools) as Array<Record<string, unknown>>;
  assert.deepEqual(tools, frozenCopy, 'the shared TOOLS array must be untouched');
  assert.equal(out[0]!.cache_control, undefined, 'earlier tools are not tagged');
  assert.deepEqual(out[1]!.cache_control, { type: 'ephemeral' }, 'the last tool carries the breakpoint');
});

test('tools: empty array is returned as-is (no breakpoint to place)', () => {
  assert.deepEqual(withToolsCacheBreakpoint([]), []);
});

test('message with string content is converted to a tagged text block without mutating the input', () => {
  const messages = [{ role: 'user', content: 'hello' }];
  const out = withMessageCacheBreakpoint(messages) as Array<{ role: string; content: unknown }>;
  assert.equal(messages[0]!.content, 'hello', 'original message is untouched');
  assert.deepEqual(out[0]!.content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
});

test('message with array content tags only its LAST part and clones the parts', () => {
  const parts = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  const messages = [{ role: 'user', content: parts }];
  const out = withMessageCacheBreakpoint(messages) as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal((parts[1] as Record<string, unknown>).cache_control, undefined, 'original parts untouched');
  assert.equal(out[0]!.content[0]!.cache_control, undefined);
  assert.deepEqual(out[0]!.content[1]!.cache_control, { type: 'ephemeral' });
});

test('only the last message is tagged — earlier turns cache as part of the prefix', () => {
  const messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'second' }];
  const out = withMessageCacheBreakpoint(messages) as Array<{ role: string; content: unknown }>;
  assert.equal(out[0]!.content, 'first', 'earlier messages are not tagged');
  assert.equal(out[1]!.content, 'reply');
  assert.deepEqual(out[2]!.content, [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }]);
});

test('empty message list and empty-string content are handled without throwing', () => {
  assert.deepEqual(withMessageCacheBreakpoint([]), []);
  const empty = [{ role: 'user', content: '' }];
  assert.deepEqual(withMessageCacheBreakpoint(empty), empty, 'an empty string can\'t carry cache_control — left as-is');
});

test('isCacheRejection catches a gateway 400/422 that names cache_control, so we can degrade', () => {
  assert.equal(isCacheRejection(400, 'invalid field cache_control'), true);
  assert.equal(isCacheRejection(422, 'prompt caching not supported'), true);
  assert.equal(isCacheRejection(400, 'unexpected ephemeral marker'), true);
});

test('isCacheRejection ignores unrelated errors and non-4xx statuses', () => {
  assert.equal(isCacheRejection(400, 'invalid model'), false, 'a plain bad-request is not a cache issue');
  assert.equal(isCacheRejection(500, 'cache_control'), false, 'a 5xx is transient, retried on the normal path');
  assert.equal(isCacheRejection(401, 'cache_control'), false, 'auth failures are terminal, not a cache degrade');
});
