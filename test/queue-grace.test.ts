import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitReadyQueue, msUntilReady, QUEUE_GRACE_MS } from '../src/agent/AgentSession';

// Grace window for messages queued while the agent is working. The bug this guards: a message was folded
// into the task the instant the next turn boundary landed — too fast to edit. Now a freshly-queued item
// waits QUEUE_GRACE_MS before it's eligible, so the user can edit or cancel it (and the current step can
// finish) first. These tests are written from the breaking-input stance: prove a JUST-queued message is
// NOT taken, that only ripe ones are, and that an edit-refreshed window pushes pickup back.

const T0 = 1_000_000; // a fixed "now" so the tests don't depend on the wall clock

test('a message queued right now is NOT ready yet — this is the "took it too fast" regression', () => {
  const items = [{ id: 'a', text: 'hi', readyAt: T0 + QUEUE_GRACE_MS }]; // enqueue sets readyAt = now + grace
  const { ready, pending } = splitReadyQueue(items, T0);
  assert.equal(ready.length, 0, 'must not be folded in the instant it is queued');
  assert.equal(pending.length, 1, 'it stays queued so the chip is still editable');
});

test('a message becomes ready once its grace window has elapsed', () => {
  const items = [{ id: 'a', text: 'hi', readyAt: T0 + QUEUE_GRACE_MS }];
  const { ready, pending } = splitReadyQueue(items, T0 + QUEUE_GRACE_MS); // exactly at the boundary
  assert.equal(ready.length, 1, 'ripe at the boundary (<=)');
  assert.equal(pending.length, 0);
});

test('only the ripe messages drain; ones still in their window are kept', () => {
  const items = [
    { id: 'old', text: 'first', readyAt: T0 - 500 },        // queued a while ago — ripe
    { id: 'new', text: 'second', readyAt: T0 + QUEUE_GRACE_MS }, // just queued — not yet
  ];
  const { ready, pending } = splitReadyQueue(items, T0);
  assert.deepEqual(ready.map((i) => i.id), ['old']);
  assert.deepEqual(pending.map((i) => i.id), ['new'], 'the young message is not grabbed with the old one');
});

test('msUntilReady returns the wait for the EARLIEST-ripening message', () => {
  const items = [
    { readyAt: T0 + 5000 },
    { readyAt: T0 + 2000 }, // earliest
    { readyAt: T0 + 9000 },
  ];
  assert.equal(msUntilReady(items, T0), 2000, 'wait only as long as the soonest one needs');
});

test('msUntilReady is 0 when a message is already ripe or nothing is queued', () => {
  assert.equal(msUntilReady([], T0), 0, 'empty queue never blocks a finish');
  assert.equal(msUntilReady([{ readyAt: T0 - 1 }], T0), 0, 'already ripe = no wait');
  assert.equal(msUntilReady([{ readyAt: T0 }], T0), 0, 'ripe exactly now = no wait');
});

test('editing/opening a chip pushes its readiness back so a fresh edit is never grabbed mid-type', () => {
  // touchQueued / editQueued reset readyAt = now + grace. Simulate: item was about to ripen, user opens it.
  const almostRipe = { id: 'a', text: 'draft', readyAt: T0 + 200 };
  assert.equal(msUntilReady([almostRipe], T0), 200);
  const refreshed = { ...almostRipe, readyAt: T0 + QUEUE_GRACE_MS }; // touchQueued at T0
  assert.equal(msUntilReady([refreshed], T0), QUEUE_GRACE_MS, 'opening the chip buys a full window again');
  assert.equal(splitReadyQueue([refreshed], T0 + 200).ready.length, 0, 'no longer grabbed at the old ripen time');
});
