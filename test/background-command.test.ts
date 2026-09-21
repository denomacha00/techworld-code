import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapped, describeBackgroundStatus, formatBackgroundReport, unknownTokenMessage, type BackgroundState } from '../src/tools/backgroundCommand';

// Background commands let the agent start a long job (a 15-min PyInstaller build, a dev server) and poll it
// across turns, instead of a foreground command that blocks and gets cut off. These test the pure
// bookkeeping from the breaking-input stance: an unbounded-output process, an unknown token, a
// never-finished process, a zero-duration one.

test('appendCapped keeps only the TAIL once output exceeds the cap — a chatty server cannot grow forever', () => {
  const cap = 10;
  let buf = '';
  for (let i = 0; i < 100; i += 1) { buf = appendCapped(buf, 'X', cap); } // 100 chars through a 10-char buffer
  assert.equal(buf.length, cap, 'never exceeds the cap');
  assert.equal(buf, 'XXXXXXXXXX');
});

test('appendCapped keeps the MOST RECENT chars (the tail), dropping the oldest', () => {
  const out = appendCapped('aaaaa', 'bcdef', 6); // 'aaaaabcdef' (10 chars) capped to its last 6
  assert.equal(out, 'abcdef', 'the newest output survives, the oldest is dropped');
});

test('appendCapped under the cap is a plain concat (no truncation)', () => {
  assert.equal(appendCapped('foo', 'bar', 100), 'foobar');
});

test('describeBackgroundStatus reports RUNNING with elapsed while the process is alive', () => {
  const proc = { running: true, exitCode: undefined, startedAt: 1000, endedAt: undefined };
  assert.equal(describeBackgroundStatus(proc, 4000), 'RUNNING (3s so far)', 'uses now when not yet ended');
});

test('describeBackgroundStatus reports EXITED with the code once finished, frozen at endedAt', () => {
  const proc = { running: false, exitCode: 0, startedAt: 1000, endedAt: 9000 };
  assert.equal(describeBackgroundStatus(proc, 999999), 'EXITED (code 0, ran 8s)', 'elapsed frozen at endedAt, not now');
});

test('describeBackgroundStatus shows a nonzero exit code (a failed build must be visible)', () => {
  const proc = { running: false, exitCode: 1, startedAt: 0, endedAt: 2000 };
  assert.match(describeBackgroundStatus(proc, 2000), /EXITED \(code 1/);
});

test('describeBackgroundStatus handles an unknown exit code (killed without a code) without printing undefined', () => {
  const proc = { running: false, exitCode: undefined, startedAt: 0, endedAt: 1000 };
  assert.equal(describeBackgroundStatus(proc, 1000), 'EXITED (code unknown, ran 1s)');
});

test('a still-running process with no output yet reads clearly, not blank', () => {
  const proc: BackgroundState = { token: 'ab12cd34', command: 'python build_exe.py', output: '', exitCode: undefined, running: true, startedAt: 0, endedAt: undefined };
  const report = formatBackgroundReport(proc, 5000);
  assert.match(report, /\(no output yet\)/);
  assert.match(report, /Still running/);
  assert.match(report, /python build_exe\.py/);
});

test('a finished process shows its output and NO "still running" tip', () => {
  const proc: BackgroundState = { token: 't', command: 'npm run build', output: 'Build complete.', exitCode: 0, running: false, startedAt: 0, endedAt: 3000 };
  const report = formatBackgroundReport(proc, 3000);
  assert.match(report, /Build complete\./);
  assert.doesNotMatch(report, /Still running/, 'no live-poll tip once it has exited');
});

test('unknownTokenMessage lists the tokens that DO exist so the model can recover', () => {
  assert.equal(unknownTokenMessage('zzz', ['ab12cd34', 'ff00ff00']), 'No background command with token "zzz". Active/finished tokens: ab12cd34, ff00ff00.');
});

test('unknownTokenMessage with nothing tracked says so plainly (no empty list)', () => {
  assert.equal(unknownTokenMessage('zzz', []), 'No background command with token "zzz", and none are running.');
});
