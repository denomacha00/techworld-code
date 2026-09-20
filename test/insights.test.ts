import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesTouched } from '../src/agent/ConversationInsights';
import type { ChatMessage } from '../src/types';

function assistant(calls: Array<{ name: string; args: unknown }>): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: calls.map((c, i) => ({ id: `c${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))
  };
}

test('collects unique read and edited paths in order', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'do it' },
    assistant([{ name: 'read_file', args: { path: 'src/a.ts' } }, { name: 'outline_file', args: { path: 'src/b.ts' } }]),
    assistant([{ name: 'edit_file', args: { path: 'src/a.ts', edits: [] } }]) // a.ts again — must dedupe
  ];
  assert.deepEqual(filesTouched(messages), ['src/a.ts', 'src/b.ts']);
});

test('extracts every path from a propose_file_edits batch, including renames', () => {
  const messages: ChatMessage[] = [
    assistant([{ name: 'propose_file_edits', args: { summary: 'x', edits: [
      { path: 'src/new.ts', content: '', operation: 'create' },
      { path: 'src/old.ts', content: '', operation: 'rename', renameTo: 'src/renamed.ts' }
    ] } }])
  ];
  assert.deepEqual(filesTouched(messages), ['src/new.ts', 'src/old.ts', 'src/renamed.ts']);
});

test('ignores non-path tools, malformed args, and directory-like values', () => {
  const messages: ChatMessage[] = [
    assistant([{ name: 'search_workspace', args: { query: 'foo' } }]),   // not a path tool
    assistant([{ name: 'list_workspace_files', args: { path: 'src' } }]), // directory, no extension → skipped
    { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: '{bad json' } }] }
  ];
  assert.deepEqual(filesTouched(messages), []);
});

test('never escapes the workspace with ..', () => {
  const messages: ChatMessage[] = [assistant([{ name: 'read_file', args: { path: '../../etc/passwd.txt' } }])];
  assert.deepEqual(filesTouched(messages), []);
});

test('normalises backslashes and leading slashes', () => {
  const messages: ChatMessage[] = [assistant([{ name: 'read_file', args: { path: '\\src\\win.ts' } }])];
  assert.deepEqual(filesTouched(messages), ['src/win.ts']);
});
