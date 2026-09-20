import type * as vscode from 'vscode';
import type { ChatMessage, ConversationMeta, StoredConversation } from '../types';

const INDEX_KEY = 'techwordCode.conversations';
const ITEM_PREFIX = 'techwordCode.conversation.';
const MAX_CONVERSATIONS = 100;

/** Persists chat conversations in globalState so users can reopen and continue them later. */
export class ConversationStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConversationMeta[] {
    return this.context.globalState.get<ConversationMeta[]>(INDEX_KEY, []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): StoredConversation | undefined {
    return this.context.globalState.get<StoredConversation>(ITEM_PREFIX + id);
  }

  async save(conversation: StoredConversation): Promise<void> {
    await this.context.globalState.update(ITEM_PREFIX + conversation.id, conversation);
    const index = this.context.globalState.get<ConversationMeta[]>(INDEX_KEY, []).filter((item) => item.id !== conversation.id);
    index.push({ id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, workspace: conversation.workspace, titleCustom: conversation.titleCustom });
    index.sort((a, b) => b.updatedAt - a.updatedAt);
    // Evict oldest beyond the cap.
    const kept = index.slice(0, MAX_CONVERSATIONS);
    for (const stale of index.slice(MAX_CONVERSATIONS)) { await this.context.globalState.update(ITEM_PREFIX + stale.id, undefined); }
    await this.context.globalState.update(INDEX_KEY, kept);
  }

  async delete(id: string): Promise<void> {
    await this.context.globalState.update(ITEM_PREFIX + id, undefined);
    const index = this.context.globalState.get<ConversationMeta[]>(INDEX_KEY, []).filter((item) => item.id !== id);
    await this.context.globalState.update(INDEX_KEY, index);
  }

  /** Rename a saved conversation. Marks the title as user-set so it is not re-derived from messages. */
  async rename(id: string, title: string): Promise<boolean> {
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean) { return false; }
    const stored = this.get(id);
    if (stored) { await this.save({ ...stored, title: clean, titleCustom: true }); return true; }
    // Not yet persisted (no messages saved): still record the title in the index so it survives.
    const index = this.context.globalState.get<ConversationMeta[]>(INDEX_KEY, []);
    const meta = index.find((item) => item.id === id);
    if (meta) { meta.title = clean; meta.titleCustom = true; await this.context.globalState.update(INDEX_KEY, index); return true; }
    return false;
  }

  /** Derive a short title from the first user message. */
  static titleFrom(messages: ChatMessage[]): string {
    const firstUser = messages.find((message) => message.role === 'user');
    const text = firstUser ? ConversationStore.plainText(firstUser.content) : '';
    const title = text.replace(/\s+/g, ' ').trim().slice(0, 60);
    return title || 'New chat';
  }

  static plainText(content: ChatMessage['content']): string {
    if (typeof content === 'string') { return content; }
    return content.map((part) => (part.type === 'text' ? part.text : '[image]')).join(' ');
  }
}
