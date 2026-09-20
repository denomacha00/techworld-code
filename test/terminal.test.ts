import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalGuard } from '../src/agent/AgentSession';

// The bug: the working bar's animation stops only on a terminal event, but the run loop had exit
// paths (user Stop, context-decline, abort between tools) that returned WITHOUT emitting one — so
// the bar animated forever with no way to clear it. createTerminalGuard is the fix: every loop exit
// runs finish() in `finally`, and it must emit exactly one terminal signal.

test('a genuine finish emits the terminal signal exactly once', () => {
  let count = 0;
  const guard = createTerminalGuard(() => { count += 1; });
  guard.finish();
  assert.equal(count, 1);
  assert.equal(guard.spent, true);
});

test('the finally-block finish() never double-fires after a normal finish', () => {
  // The loop calls finish() on the genuine-finish path, then AGAIN in `finally`. The bar must be
  // told "done" once, not twice.
  let count = 0;
  const guard = createTerminalGuard(() => { count += 1; });
  guard.finish(); // genuine-finish path
  guard.finish(); // finally
  assert.equal(count, 1, 'a second finish() must be a no-op');
});

test('user Stop / context-decline / abort — a bare finally finish() still settles the UI', () => {
  // These paths `return` early with NO terminal event of their own. The `finally` finish() is the
  // ONLY thing that clears the bar. This is the exact "animation runs, cannot even stop" case.
  let count = 0;
  const guard = createTerminalGuard(() => { count += 1; });
  // (no prior emit — simulating an early return)
  guard.finish(); // finally
  assert.equal(count, 1, 'the bar must be cleared on a silent early return');
});

test('an error path emits its own terminal event, so finish() must NOT add a second', () => {
  // The catch block emits {type:'error'} (itself terminal) and marks the guard spent; the `finally`
  // finish() then must do nothing, or the UI gets both an error AND a spurious "done".
  let completeCount = 0;
  const guard = createTerminalGuard(() => { completeCount += 1; });
  guard.markSpent();  // an error was emitted
  guard.finish();     // finally
  assert.equal(completeCount, 0, 'no "complete" after an error already terminated the task');
  assert.equal(guard.spent, true);
});

test('markSpent is idempotent and order-independent with finish', () => {
  let count = 0;
  const guard = createTerminalGuard(() => { count += 1; });
  guard.markSpent();
  guard.markSpent();
  guard.finish();
  assert.equal(count, 0);
});
