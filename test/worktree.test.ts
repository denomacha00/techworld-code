import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNameStatusZ } from '../src/agent/WorktreeManager';

test('parseNameStatusZ reads add/modify/delete entries', () => {
  const z = 'A\0new.ts\0M\0src/old.ts\0D\0gone.ts\0';
  assert.deepEqual(parseNameStatusZ(z), [
    { status: 'A', path: 'new.ts' },
    { status: 'M', path: 'src/old.ts' },
    { status: 'D', path: 'gone.ts' }
  ]);
});

test('parseNameStatusZ keeps the destination path for renames/copies', () => {
  // R<score>\0<old>\0<new> — the new path is what now exists in the worktree.
  const z = 'R100\0old/name.ts\0new/name.ts\0C75\0a.ts\0b.ts\0';
  assert.deepEqual(parseNameStatusZ(z), [
    { status: 'R', path: 'new/name.ts' },
    { status: 'R', path: 'b.ts' }
  ]);
});

test('parseNameStatusZ normalizes backslashes to forward slashes', () => {
  assert.deepEqual(parseNameStatusZ('M\0src\\tools\\a.ts\0'), [{ status: 'M', path: 'src/tools/a.ts' }]);
});

test('parseNameStatusZ tolerates empty and trailing junk', () => {
  assert.deepEqual(parseNameStatusZ(''), []);
  assert.deepEqual(parseNameStatusZ('\0\0'), []);
  // A single modify with a real name status string as git emits it.
  assert.deepEqual(parseNameStatusZ('M\0README.md\0'), [{ status: 'M', path: 'README.md' }]);
});
