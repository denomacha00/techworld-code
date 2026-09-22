export interface ProviderConfig {
  id: string;
  displayName: string;
  baseUrl: string;
  authMode: 'bearer' | 'api-key-header';
  apiKeySecretKey: string;
  selectedModel?: string;
  discoveredModels?: ModelInfo[];
  modelsFetchedAt?: number;
}

/** One external MCP (Model Context Protocol) server the user has configured. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

/** A tool discovered from an MCP server, namespaced so it can't collide with built-in tools. */
export interface McpToolInfo {
  server: string;
  toolName: string;      // the server's own name for the tool
  qualifiedName: string; // mcp__<server>__<tool>, the name exposed to the model
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface OpenAIToolCallMessage {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI-style multimodal message content parts (text + images). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** A model reasoning block from extended thinking. Carried on the assistant turn so it can be
 *  replayed verbatim (with its signature) on the next request — Anthropic requires the thinking
 *  block that preceded a tool_use to be sent back unmodified, or the follow-up turn is rejected. */
export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: OpenAIToolCallMessage[];
  /** Extended-thinking blocks the assistant produced this turn, in order, ahead of text/tool_use. */
  thinking_blocks?: ThinkingBlock[];
}

/** A snapshot of file state before an edit, so it can be reverted. before === null means the file did not exist. */
export interface Checkpoint {
  id: string;
  files: Array<{ path: string; before: string | null }>;
}

/** A file or image the user attached to a message. */
export interface Attachment {
  id: string;
  name: string;
  kind: 'image' | 'text';
  mime?: string;
  dataUrl?: string; // for images
  text?: string;    // for text files
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
  workspace?: string;
  /** True when the user renamed this chat by hand, so the title is not re-derived from the first message. */
  titleCustom?: boolean;
}

export interface StoredConversation extends ConversationMeta {
  createdAt: number;
  messages: ChatMessage[];
  totalTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface StreamDelta {
  text?: string;
  /** Real reasoning text as it streams (extended thinking). Routed to Activity, never to the chat answer. */
  thinking?: string;
  /** The finished thinking blocks (with signatures) for this turn, emitted once on the final delta. */
  thinkingBlocks?: ThinkingBlock[];
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  status?: string;
  done?: boolean;
  /** Why the model stopped: 'end_turn' (finished), 'tool_use', 'max_tokens' (cut off), 'stop_sequence', or undefined if the stream dropped. */
  stopReason?: string;
}

export interface FileEdit {
  path: string;
  content: string;
  expectedHash?: string;
  operation: 'create' | 'modify' | 'delete' | 'rename';
  renameTo?: string;
}

export interface CommandProposal {
  command: string;
  cwd?: string;
  purpose: string;
  timeoutMs?: number;
}

/** A single file change rendered as an inline diff card in the chat. */
export interface EditPreview {
  path: string;
  operation: FileEdit['operation'];
  renameTo?: string;
  oldContent: string;
  newContent: string;
  truncated: boolean;
}

/** An approval request surfaced inline in the chat panel. The user clicks Approve or Reject. */
export type ApprovalRequest =
  | { id: string; kind: 'edits'; summary: string; previews: EditPreview[] }
  | { id: string; kind: 'command'; command: string; cwd: string; purpose: string }
  | { id: string; kind: 'mcp'; server: string; tool: string; argsJson: string };

/** The webview's answer to an approval request. */
export interface ApprovalResponse {
  id: string;
  approved: boolean;
}

/** One message the user queued while the agent was busy. `id` lets the UI edit or cancel it before it's picked up. */
export interface QueuedItem { id: string; text: string; }

/** Where a saved memory lives. 'project' travels with the repo (.techword/memory.json); 'global' follows the user across all workspaces. */
export type MemoryScope = 'project' | 'global';

/** One durable fact Techword Code remembers across tasks and sessions. */
export interface MemoryEntry {
  id: string;
  text: string;
  scope: MemoryScope;
  createdAt: number;
}

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'assistantDelta'; text: string }
  | { type: 'resetStream' }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'commandOutput'; chunk: string }
  | { type: 'toolResult'; summary: string }
  | { type: 'checkpoint'; id: string; summary: string }
  | { type: 'question'; text: string; options?: string[] }
  | { type: 'preview'; dataUrl: string; name: string }
  | { type: 'usage'; total: number; window?: number; limit?: number }
  | { type: 'billing'; spentUsd: number; limitUsd?: number; meterInCents: boolean }
  | { type: 'compacted'; message: string }
  | { type: 'queued'; items: QueuedItem[] }
  | { type: 'error'; message: string }
  | { type: 'complete' };
