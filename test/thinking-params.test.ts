import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thinkingParams, shouldCapFirstByte } from '../src/providers/OpenAICompatibleClient';

// THE speed fix. Measured against the real upstream: a turn is ≈10× faster to first byte (~4s vs ~40s)
// when the request EXPLICITLY sends thinking:{type:'disabled'} instead of omitting the param. Omitting it
// leaves slow hidden reasoning on — the root cause of "it takes forever to code." These tests guard that
// the default (thinking off) never regresses back to omitting the param.

test('default path (thinking off) MUST explicitly disable thinking — this is the speed lever', () => {
  const p = thinkingParams({ thinkingOn: false, maxTokens: 16384, sendDisabledThinking: true, temperature: 0 });
  assert.deepEqual(p.thinking, { type: 'disabled' }, 'must send {type:disabled}, not omit it');
  assert.equal(p.temperature, 0, 'temperature is allowed (and kept) when thinking is off');
});

test('temperature is clamped to [0,1] on the disabled path', () => {
  assert.equal(thinkingParams({ thinkingOn: false, maxTokens: 16384, sendDisabledThinking: true, temperature: 5 }).temperature, 1);
  assert.equal(thinkingParams({ thinkingOn: false, maxTokens: 16384, sendDisabledThinking: true, temperature: -2 }).temperature, 0);
});

test('once a gateway rejects the disabled param, we stop sending it (graceful degrade, no hard fail)', () => {
  const p = thinkingParams({ thinkingOn: false, maxTokens: 16384, sendDisabledThinking: false, temperature: 0 });
  assert.equal(p.thinking, undefined, 'a stricter gateway degrades to omitting the param instead of 400ing');
  assert.equal(p.temperature, 0, 'temperature still goes through');
});

test('thinking ON sends an enabled block with a clamped budget and NO temperature', () => {
  const p = thinkingParams({ thinkingOn: true, maxTokens: 16384, sendDisabledThinking: true, thinkingBudget: 2048, temperature: 0 });
  assert.deepEqual(p.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(p.temperature, undefined, 'Anthropic forbids temperature alongside enabled thinking');
});

test('thinking ON but maxTokens too small to fit a budget falls back to the fast disabled path', () => {
  // maxTokens must exceed MIN_THINKING_BUDGET(1024)+256 to enable thinking; below that, disable it.
  const p = thinkingParams({ thinkingOn: true, maxTokens: 1024, sendDisabledThinking: true, thinkingBudget: 2048 });
  assert.deepEqual(p.thinking, { type: 'disabled' }, 'no room for a budget → stay on the fast path');
});

test('an over-large thinking budget is capped below max_tokens', () => {
  const p = thinkingParams({ thinkingOn: true, maxTokens: 4096, sendDisabledThinking: true, thinkingBudget: 999999 });
  assert.deepEqual(p.thinking, { type: 'enabled', budget_tokens: 4096 - 256 });
});

// The TTFB (time-to-first-byte) cap re-rolls a stuck channel — but only when we can tell fast from slow.
// With thinking OFF a fast channel answers in a few seconds, so a 25s silence means a bad channel worth
// dropping. With thinking ON a long first-byte wait is the model reasoning, not a stuck channel, so we
// must never cut it. And after a few re-rolls the upstream is slow everywhere — stop capping and wait it out.

test('first-byte cap is ON when thinking is off and we still have re-roll budget', () => {
  assert.equal(shouldCapFirstByte(false, 0), true);
  assert.equal(shouldCapFirstByte(false, 2), true, 'still under the budget of 3');
});

test('first-byte cap is OFF once the re-roll budget is spent — the upstream is just slow everywhere', () => {
  assert.equal(shouldCapFirstByte(false, 3), false, 'budget reached → stop capping, wait it out');
  assert.equal(shouldCapFirstByte(false, 10), false);
});

test('first-byte cap is NEVER applied when thinking is on — a long wait is the model reasoning, not a stuck channel', () => {
  assert.equal(shouldCapFirstByte(true, 0), false);
  assert.equal(shouldCapFirstByte(true, 2), false);
});
