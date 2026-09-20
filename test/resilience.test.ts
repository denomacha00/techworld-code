import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TechwordApiError, isTerminalError } from '../src/providers/OpenAICompatibleClient';

// The rule the user asked for: NEVER stop a task on a network/timeout/stall — keep retrying until the
// connection comes back. ONLY stop when the key is dead or tokens are exhausted. isTerminalError is
// the switch that decides that, so it must classify each case correctly.

test('a dead/expired key is terminal — it must stop and reach the user', () => {
  assert.equal(isTerminalError(new TechwordApiError('key invalid', true)), true);
});

test('exhausted tokens are terminal — retrying can never make money appear', () => {
  assert.equal(isTerminalError(new TechwordApiError('tokens used up', true)), true);
});

test('network/timeout/stall errors are NOT terminal — the loop keeps retrying', () => {
  assert.equal(isTerminalError(new TechwordApiError('Connection dropped mid-reply.', false)), false);
  assert.equal(isTerminalError(new TechwordApiError('did not respond in time', false)), false);
  assert.equal(isTerminalError(new TechwordApiError('rate limit', false)), false);
});

test('an unknown/plain error is treated as retryable, not a hard stop', () => {
  // Anything that isn't explicitly tagged terminal must not kill an autonomous run.
  assert.equal(isTerminalError(new Error('something odd')), false);
  assert.equal(isTerminalError('a string'), false);
  assert.equal(isTerminalError(undefined), false);
});
