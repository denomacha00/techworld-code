import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChannelRejection } from '../src/providers/OpenAICompatibleClient';

// The shape of upstream body seen when a valid key is routed to a channel it isn't cleared for.
const REAL_403 = '{"error":{"type":"\\u003cnil\\u003e","message":"this API key is not allowed to use channel \\"channel-a\\" (allowed: [\\"channel-b\\", \\"channel-c\\"]) (request id: 20260101...)"},"type":"error"}';

test('detects the channel-routing 403 so it can be re-rolled', () => {
  assert.equal(isChannelRejection(403, REAL_403), true);
});

test('detects the Chinese-locale channel rejection wording', () => {
  assert.equal(isChannelRejection(403, '当前分组 default 下无权使用渠道'), true);
});

test('a real auth failure (invalid key) is NOT treated as a channel re-roll', () => {
  // 401 must reach the user unretried — retrying a dead key just spins.
  assert.equal(isChannelRejection(401, '{"error":{"message":"invalid api key"}}'), false);
});

test('a plain 403 without channel wording is not re-rolled', () => {
  // e.g. a genuine permission/forbidden error — retrying wouldn't help.
  assert.equal(isChannelRejection(403, '{"error":{"message":"forbidden"}}'), false);
});

test('"no available channel" (model not on plan) is NOT a re-roll — the user must act', () => {
  // This means NO channel serves the model at all; re-rolling can never succeed.
  assert.equal(isChannelRejection(403, 'no available channel for this model'), false);
});
