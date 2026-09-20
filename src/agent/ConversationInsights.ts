import type { ChatMessage } from '../types';

/** Tools whose arguments name a workspace path. Used to list what a conversation touched. */
const PATH_TOOLS = new Set(['read_file', 'edit_file', 'outline_file', 'find_usages', 'preview_in_chat', 'list_workspace_files', 'get_diagnostics']);

/**
 * Extract the unique, in-order list of workspace files a conversation has read or edited,
 * by parsing the file-path arguments of the assistant's tool calls. Malformed calls are skipped.
 */
export function filesTouched(messages: ChatMessage[]): string[] {
  const seen = new Set<string>();
  const add = (p: unknown): void => {
    if (typeof p !== 'string') { return; }
    const clean = p.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    // Keep things that look like a file path (have an extension) and can't escape the workspace.
    if (clean && !clean.includes('..') && /\.[a-z0-9]+$/i.test(clean)) { seen.add(clean); }
  };
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.tool_calls) { continue; }
    for (const call of message.tool_calls) {
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        if (call.function.name === 'propose_file_edits' && Array.isArray(args.edits)) {
          for (const edit of args.edits as Array<Record<string, unknown>>) { add(edit.path); add(edit.renameTo); }
        } else if (PATH_TOOLS.has(call.function.name)) {
          add(args.path);
        }
      } catch { /* malformed arguments — skip */ }
    }
  }
  return [...seen];
}
