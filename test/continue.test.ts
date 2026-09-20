import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intendsToContinue, decideAfterEmptyTurn, EMPTY_RESPONSE_LIMIT, STALL_NUDGE_LIMIT, nudgeMessage, canRunInParallel } from '../src/agent/AgentSession';

// Parallel read-only tool execution: when the model batches several PURE reads in one turn, run them at
// once (like Claude Code / Cursor) instead of serially. The safety rule under test: a single write/
// approval/ordered call anywhere in the batch forces the WHOLE batch sequential, so nothing races an edit.

test('a batch of pure reads runs in parallel', () => {
  assert.equal(canRunInParallel([{ name: 'read_file' }, { name: 'read_file' }, { name: 'search_workspace' }]), true);
  assert.equal(canRunInParallel([{ name: 'list_workspace_files' }, { name: 'get_git_diff' }, { name: 'find_symbol' }]), true);
});

test('one write/side-effect call forces the whole batch sequential', () => {
  assert.equal(canRunInParallel([{ name: 'read_file' }, { name: 'edit_file' }]), false, 'never race a read against an edit');
  assert.equal(canRunInParallel([{ name: 'read_file' }, { name: 'run_terminal_command' }]), false);
  assert.equal(canRunInParallel([{ name: 'read_file' }, { name: 'remember' }]), false);
});

test('approval- and ordering-sensitive tools are never parallelized', () => {
  assert.equal(canRunInParallel([{ name: 'read_file' }, { name: 'ask_user' }]), false, 'ask_user blocks on the user');
  assert.equal(canRunInParallel([{ name: 'read_file' }, { name: 'preview_in_chat' }]), false, 'preview emits ordered UI');
  assert.equal(canRunInParallel([{ name: 'read_file' }, { name: 'spawn_explorer' }]), false, 'explorers already fan out internally');
});

test('a single call is not "parallel" — the fast path only helps with 2+', () => {
  assert.equal(canRunInParallel([{ name: 'read_file' }]), false);
  assert.equal(canRunInParallel([]), false);
});

test('detects a cliffhanger that announces an unfinished action', () => {
  for (const text of [
    'Let me check the repo state.',
    "Now I'll run the tests.",
    'First I will read the file:',
    "I'll bump the version and commit.",
    'Let me verify the build now',
    'Next, I will update the changelog:'
  ]) {
    assert.equal(intendsToContinue(text), true, `should continue after: ${text}`);
  }
});

test('an empty reply is treated as unfinished', () => {
  assert.equal(intendsToContinue(''), true);
  assert.equal(intendsToContinue('   '), true);
});

test('genuine completions and hand-backs do NOT loop', () => {
  for (const text of [
    'All done — the tests pass and the build is green.',
    'I fixed the bug in utils.ts and verified it with npm test. Everything passes.',
    'Which option would you like: A or B?',
    'Let me know if you want any changes.',
    'Would you like me to also update the docs?',
    'Done. The extension is packaged as techword-code-1.2.0.vsix.'
  ]) {
    assert.equal(intendsToContinue(text), false, `should stop after: ${text}`);
  }
});

test('a normal explanatory sentence does not falsely trigger', () => {
  assert.equal(intendsToContinue('The function reads the file and returns its contents.'), false);
});

// decideAfterEmptyTurn: the fix for the "stops mid-task showing nothing" bug.
const base = { mode: 'act' as const, text: '', stopReason: undefined as string | undefined, autoContinues: 0, emptyResponses: 0 };

test('a reply cut off at the token limit CONTINUES, never stops', () => {
  // This is the Mr DM case: huge changelog, output truncated. Even text that looks finished must continue.
  assert.equal(decideAfterEmptyTurn({ ...base, text: 'All done, tests pass.', stopReason: 'max_tokens' }), 'continue-truncated');
  assert.equal(decideAfterEmptyTurn({ ...base, text: 'partial changelog line that got cut o', stopReason: 'max_tokens' }), 'continue-truncated');
});

test('a dropped/empty stream retries persistently, then fails loudly — never a silent stop', () => {
  // Retry through a long patch of dropped turns so a big autonomous run survives it...
  assert.equal(decideAfterEmptyTurn({ ...base, text: '', stopReason: undefined, emptyResponses: 0 }), 'retry-empty');
  assert.equal(decideAfterEmptyTurn({ ...base, text: '', stopReason: undefined, emptyResponses: EMPTY_RESPONSE_LIMIT - 1 }), 'retry-empty');
  // ...but keep a ceiling so a genuinely broken request can't spin forever with zero progress.
  assert.equal(decideAfterEmptyTurn({ ...base, text: '', stopReason: undefined, emptyResponses: EMPTY_RESPONSE_LIMIT }), 'fail-empty');
  assert.ok(EMPTY_RESPONSE_LIMIT >= 10, 'tolerance should be high enough for long unattended runs');
});

test('a genuine end_turn with a real summary completes', () => {
  assert.equal(decideAfterEmptyTurn({ ...base, text: 'Done — bumped the version, committed and pushed.', stopReason: 'end_turn' }), 'complete');
});

test('a cliffhanger with end_turn still gets nudged (the model said it would act but did not)', () => {
  assert.equal(decideAfterEmptyTurn({ ...base, text: "Now I'll commit and push.", stopReason: 'end_turn' }), 'nudge');
});

test('the nudge keeps pushing well past a few tries (the user proved retrying works), but is still bounded', () => {
  // Persistent: a stall at attempt 4 must STILL nudge, not give up — this was the "it should have retried
  // because I retried twice and it worked" bug.
  assert.equal(decideAfterEmptyTurn({ ...base, text: "Let me run the tests.", stopReason: 'end_turn', autoContinues: 4 }), 'nudge');
  assert.equal(decideAfterEmptyTurn({ ...base, text: "Let me run the tests.", stopReason: 'end_turn', autoContinues: STALL_NUDGE_LIMIT - 1 }), 'nudge');
  // …but bounded, so a provider that genuinely can't tool-call still terminates instead of spinning forever.
  assert.equal(decideAfterEmptyTurn({ ...base, text: "Let me run the tests.", stopReason: 'end_turn', autoContinues: STALL_NUDGE_LIMIT }), 'complete');
  assert.ok(STALL_NUDGE_LIMIT >= 20, 'should push far harder than the old limit of 4');
});

test('the nudge escalates from a soft continue to an act-only demand', () => {
  assert.match(nudgeMessage(1), /continue/i);
  assert.match(nudgeMessage(5), /only valid next output is a tool call/i);
  assert.notEqual(nudgeMessage(1), nudgeMessage(5)); // identical repeats are what let it narrate-loop
});

test('Plan mode never nudges (read-only, hand back to the user)', () => {
  assert.equal(decideAfterEmptyTurn({ ...base, mode: 'plan', text: "Now I'll edit the file.", stopReason: 'end_turn' }), 'complete');
});
