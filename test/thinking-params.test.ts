import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thinkingParams, shouldCapFirstByte, firstByteCapMs } from '../src/providers/OpenAICompatibleClient';

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

// The TTFB (time-to-first-byte) cap re-rolls a stuck channel. Measured, this gateway's channels are BIMODAL:
// a healthy one delivers in ~4-35s, a dead one never delivers — it hangs to the proxy's ~120s timeout, then
// 500/524. So with thinking OFF we ALWAYS cap: a dead channel does not recover by waiting, so every attempt
// gets a deadline and re-rolls onto a fresh channel. What's bounded is the NUMBER of re-rolls (in the loop),
// not the cap — turning the cap off is exactly what let a dead channel hang 120s and storm retries. With
// thinking ON a long first-byte wait is the model reasoning, not a stuck channel, so we never cut it.

test('first-byte cap is ALWAYS on when thinking is off — a stuck channel never recovers by waiting', () => {
  assert.equal(shouldCapFirstByte(false), true);
});

test('first-byte cap is NEVER applied when thinking is on — a long wait is the model reasoning, not a stuck channel', () => {
  assert.equal(shouldCapFirstByte(true), false);
});

// The first-byte cap is PROGRESSIVE: the first probe is the likely cold prefill (first request of a run, or
// the first after the 5-min prompt-cache TTL lapses) and must get room, or we abort a request that would
// have delivered and re-roll into another cold prefill — the retry storm. Re-rolls after it hunt a healthy
// channel; 20s catches the fast ones fast while still giving a cold re-roll room to prefill.
test('first probe gets a generous cap (cold prefill / expired cache), re-rolls hunt fast', () => {
  assert.equal(firstByteCapMs(0), 45000, 'first probe: room for a real cold prefill on a full context, not a snap re-roll');
  assert.equal(firstByteCapMs(1), 20000, 're-roll: hunt a healthy channel, but leave room for a cold prefill');
  assert.equal(firstByteCapMs(2), 20000);
});

test('the first probe is MORE generous than every re-roll — a cold start must not be cut short and re-rolled', () => {
  // The retry storm the user hit came from a first probe SHORTER than the real cold-prefill time: it aborted
  // a request that would have delivered, then re-rolled into another cold channel. The first wait must always
  // exceed a re-roll wait so a legitimate cold start finishes on the first channel with no retry message.
  assert.ok(firstByteCapMs(0) > firstByteCapMs(1), 'first probe must out-wait a re-roll');
});

test('every attempt is capped in a bounded chunk — no single attempt can hang out to the ~120s proxy timeout', () => {
  // The bug: after the old budget was "spent" we stopped capping, so an attempt could hang uncapped to the
  // proxy's 120s timeout, 500, back off, and hang again. Now EVERY attempt is capped, so no single wait ever
  // approaches 120s — the worst case is a sum of small capped chunks that each escape a dead channel.
  for (let r = 0; r <= 6; r += 1) { assert.ok(firstByteCapMs(r) <= 45000, 'no attempt waits more than the first probe'); }
  assert.ok(firstByteCapMs(1) < 120000, 'a re-roll never approaches the proxy origin timeout');
});
