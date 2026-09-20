import type { AgentEvent, Attachment, ApprovalRequest, ChatMessage, CommandProposal, ContentPart, FileEdit, ProviderConfig, QueuedItem, ThinkingBlock, ToolCall } from '../types';
import { OpenAICompatibleClient, isTerminalError, ThinkingUnsupportedError, type GenerationOptions } from '../providers/OpenAICompatibleClient';
import type { ApprovalBroker } from '../security/ApprovalBroker';
import type { WorkspaceToolExecutor } from '../tools/WorkspaceToolExecutor';
import type { McpHub } from '../mcp/McpHub';
import { parseEdits, SYSTEM_PROMPT, TOOLS } from './ToolDefinitions';
import { randomUUID } from 'node:crypto';

/** Asks the UI to approve a proposal inline; resolves true when the user approves. */
export type ApprovalGate = (request: ApprovalRequest) => Promise<boolean>;
export type ContextMode = 'auto' | 'ask';
export type AgentMode = 'plan' | 'act';

/** How the session saves/removes durable memories. The provider backs this with the on-disk MemoryStore. */
export interface MemorySink {
  remember(text: string, scope?: 'project' | 'global'): Promise<string>;
  forget(query: string): Promise<string>;
}

// remember/forget only touch Techword's own memory file — never user code — so they're allowed in Plan mode too.
const READONLY_TOOLS = new Set(['list_workspace_files', 'read_file', 'search_workspace', 'get_git_status', 'get_git_diff', 'get_diagnostics', 'find_symbol', 'outline_file', 'find_usages', 'code_map', 'ask_user', 'web_fetch', 'preview_in_chat', 'spawn_explorer', 'remember', 'forget']);

export class AgentSession {
  private projectRules = '';
  private memoryText = '';
  private memorySink: MemorySink | undefined;
  private messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  private abortController: AbortController | undefined;
  private totalTokens = 0;
  private lastTurnTokens = 0;
  private contextMode: ContextMode = 'auto';
  private contextLimit = 120000;
  private queued: QueuedItem[] = [];
  private mode: AgentMode = 'act';
  private maxSteps = 100;
  private genOptions: GenerationOptions = {};
  // Whether this gateway can do extended thinking. Flips to false on the first rejection and stays
  // there for the session, so we don't re-probe a gateway we already know can't do it.
  private thinkingSupported = true;
  private webFetchEnabled = true;
  private questionResolver: ((answer: string) => void) | undefined;
  private mcp: McpHub | undefined;
  private autoContinues = 0;
  private emptyResponses = 0;

  constructor(
    private provider: ProviderConfig,
    private apiKey: string,
    private readonly executor: WorkspaceToolExecutor,
    private readonly approvals: ApprovalBroker,
    private readonly emit: (event: AgentEvent) => void,
    private readonly gate: ApprovalGate
  ) {}

  get running(): boolean { return this.abortController !== undefined; }
  get tokens(): number { return this.totalTokens; }

  /** Update model/provider mid-conversation without losing history. */
  setProvider(provider: ProviderConfig): void { this.provider = provider; }
  setApiKey(apiKey: string): void { this.apiKey = apiKey; }

  /** Inject repo instruction files (AGENTS.md etc.) into the system prompt. */
  setProjectRules(rules: string): void {
    this.projectRules = rules.trim();
    if (this.messages[0]?.role === 'system') { this.messages[0] = this.systemMessage(); }
  }

  /** Inject saved cross-session memories into the system prompt. Re-applied live after remember/forget. */
  setMemory(memory: string): void {
    this.memoryText = memory.trim();
    if (this.messages[0]?.role === 'system') { this.messages[0] = this.systemMessage(); }
  }

  /** Provide the backing store so the remember/forget tools can persist. */
  setMemorySink(sink: MemorySink | undefined): void { this.memorySink = sink; }

  private systemMessage(): ChatMessage {
    let content = SYSTEM_PROMPT;
    if (this.memoryText) { content += `\n\n<memory>\n${this.memoryText}\n</memory>`; }
    if (this.projectRules) { content += `\n\n<project_instructions>\nThe repository provides these instructions. Follow them unless they conflict with safety.\n\n${this.projectRules}\n</project_instructions>`; }
    return { role: 'system', content };
  }
  setContext(mode: ContextMode, limit: number): void { this.contextMode = mode; this.contextLimit = Math.max(8000, limit); }
  setMode(mode: AgentMode): void { this.mode = mode; }
  setMaxSteps(n: number): void { this.maxSteps = Math.min(2000, Math.max(10, n)); }
  setGenerationOptions(options: GenerationOptions): void { this.genOptions = options; }
  setWebFetchEnabled(enabled: boolean): void { this.webFetchEnabled = enabled; }
  /** Provide the MCP hub so external-server tools are offered to the model (Act mode only). */
  setMcpHub(hub: McpHub | undefined): void { this.mcp = hub; }

  /** In Plan mode, only read-only tools are offered so the agent proposes a plan instead of changing anything. */
  private activeTools(): unknown[] {
    let tools: unknown[] = this.mode === 'plan' ? TOOLS.filter((tool) => READONLY_TOOLS.has(tool.name)) : [...TOOLS];
    if (!this.webFetchEnabled) { tools = (tools as Array<{ name: string }>).filter((tool) => tool.name !== 'web_fetch'); }
    // MCP tools can have side effects, so only offer them in Act mode. They're approval-gated at call time.
    if (this.mode === 'act' && this.mcp?.hasTools()) { tools = [...tools, ...this.mcp.toolDefinitions()]; }
    return tools;
  }

  /** Snapshot for persistence. */
  getMessages(): ChatMessage[] { return this.messages; }
  loadMessages(messages: ChatMessage[], totalTokens: number): void {
    if (this.running) { throw new Error('Stop the current task first.'); }
    this.messages = messages.length > 0 ? messages : [this.systemMessage()];
    if (this.messages[0]?.role !== 'system') { this.messages.unshift(this.systemMessage()); }
    else { this.messages[0] = this.systemMessage(); }
    this.totalTokens = totalTokens;
    this.lastTurnTokens = 0;
  }

  /** Clear conversation history to start a fresh task. */
  reset(): void {
    if (this.running) { throw new Error('Stop the current task before starting a new one.'); }
    this.messages = [this.systemMessage()];
    this.totalTokens = 0;
    this.lastTurnTokens = 0;
    this.queued = [];
  }

  /** Queue a message while the agent is working; it's folded into the current task at the next step. */
  enqueue(prompt: string): string { const id = randomUUID(); this.queued.push({ id, text: prompt }); this.emitQueued(); return id; }
  /** Edit a still-pending queued message before the agent picks it up. */
  editQueued(id: string, text: string): void { const item = this.queued.find((q) => q.id === id); if (item) { item.text = text; this.emitQueued(); } }
  /** Cancel a still-pending queued message (rewind). */
  removeQueued(id: string): void { const before = this.queued.length; this.queued = this.queued.filter((q) => q.id !== id); if (this.queued.length !== before) { this.emitQueued(); } }
  get queuedItems(): QueuedItem[] { return this.queued.map((q) => ({ ...q })); }
  get hasQueued(): boolean { return this.queued.length > 0; }
  private emitQueued(): void { this.emit({ type: 'queued', items: this.queuedItems }); }

  /** True while the agent is blocked on an ask_user question. */
  get awaitingAnswer(): boolean { return this.questionResolver !== undefined; }
  /** Deliver the user's reply to a pending ask_user question. */
  answer(text: string): void { const resolve = this.questionResolver; this.questionResolver = undefined; if (resolve) { resolve(text); } }

  async run(prompt: string, attachments: Attachment[] = []): Promise<void> {
    if (this.abortController) { throw new Error('A Techword Code task is already running.'); }
    this.messages.push({ role: 'user', content: await this.buildUserContent(prompt, attachments) });

    // The underlying model may insist on its own identity; own the answer to identity questions here.
    const identity = attachments.length === 0 ? this.identityAnswer(prompt) : undefined;
    if (identity) {
      this.messages.push({ role: 'assistant', content: identity });
      this.emit({ type: 'assistantDelta', text: identity });
      this.emit({ type: 'complete' });
      return;
    }
    await this.loop();
  }

  /** Re-run on the existing conversation after a failure, without adding a new user message. */
  async retry(): Promise<void> {
    if (this.abortController) { throw new Error('A Techword Code task is already running.'); }
    if (!this.messages.some((message) => message.role === 'user')) { return; }
    await this.loop();
  }

  private async loop(): Promise<void> {
    this.abortController = new AbortController();
    this.autoContinues = 0;
    // Every exit path — genuine finish, user Stop, context-decline, abort between tools, or a thrown
    // error — MUST tell the UI the task is over, or the working bar animates forever with no way to
    // clear it. finish() emits exactly one terminal 'complete'; the finally guarantees it always runs.
    const guard = createTerminalGuard(() => this.emit({ type: 'complete' }));
    const finish = guard.finish;
    try {
      const client = new OpenAICompatibleClient(this.provider, this.apiKey, { ...this.genOptions, thinking: this.genOptions.thinking === true && this.thinkingSupported });
      for (let turn = 0; turn < this.maxSteps; turn += 1) {
        this.drainQueue();
        if (!await this.manageContext(client)) { return; }
        this.emit({ type: 'status', message: 'Working…' });
        const turn_ = await this.streamTurn(client);
        if (!turn_) { return; } // user stopped
        const { text, calls, stopReason, thinkingBlocks } = turn_;
        if (text || calls.length > 0) {
          const assistant: ChatMessage = { role: 'assistant', content: text, tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
          // Keep thinking blocks on the turn that has tool calls: Anthropic needs them replayed verbatim
          // on the follow-up request, or it rejects it. On a plain text turn they're not needed downstream.
          if (thinkingBlocks.length > 0 && calls.length > 0) { assistant.thinking_blocks = thinkingBlocks; }
          this.messages.push(assistant);
        }

        if (calls.length === 0) {
          if (this.queued.length > 0) { this.emptyResponses = 0; continue; } // user added more work while it was running

          const decision = decideAfterEmptyTurn({ mode: this.mode, text, stopReason, autoContinues: this.autoContinues, emptyResponses: this.emptyResponses });
          if (decision === 'continue-truncated') {
            // The response was CUT OFF at the output-token limit — not finished. Continue it so long
            // work (big changelogs, many files) never silently stops half-done. Not a stall.
            this.emit({ type: 'status', message: 'Response hit the length limit — continuing…' });
            this.messages.push({ role: 'user', content: 'Your previous response was cut off at the length limit. Continue exactly where you left off. If you were part-way through a step, finish it and carry on to completion — call the tools you need.' });
            this.autoContinues = 0;
            continue;
          }
          if (decision === 'retry-empty') {
            // The stream returned NOTHING (provider dropped the turn). Retry visibly.
            this.emptyResponses += 1;
            this.emit({ type: 'status', message: `Model returned an empty response — retrying (${this.emptyResponses}/${EMPTY_RESPONSE_LIMIT})…` });
            continue;
          }
          if (decision === 'fail-empty') {
            this.emptyResponses = 0;
            throw new Error('The model returned an empty response several times in a row. This is usually a temporary provider issue — say "continue" to try again.');
          }
          if (decision === 'nudge') {
            // Stopped mid-thought ("Let me check…", trailing colon) without calling a tool. Nudge it —
            // and escalate: a soft "continue" repeated identically is exactly what lets a model settle
            // into a narrate-loop (say it'll act, never act). Later nudges forbid prose outright so the
            // only valid move left is a real tool call. Keeps pushing up to STALL_NUDGE_LIMIT.
            this.autoContinues += 1;
            this.messages.push({ role: 'user', content: nudgeMessage(this.autoContinues) });
            if (this.autoContinues > 1) { this.emit({ type: 'status', message: `Model described a step without running it — pushing it to act (attempt ${this.autoContinues})…` }); }
            continue;
          }
          // Genuinely finished. Guarantee the turn never ends completely blank. If we got here after
          // exhausting nudges (the model kept announcing steps without calling a tool), say so plainly
          // and tell the user how to push it — never a cryptic "(no output)" that looks like a crash.
          const stalled = this.autoContinues > 0;
          this.autoContinues = 0;
          this.emptyResponses = 0;
          if (!text.trim()) {
            this.emit({ type: 'assistantDelta', text: stalled
              ? 'I kept describing the next step without running it. This can happen if extended thinking is on for a provider that doesn\'t fully support it — turn off "Show thinking" in Settings if it is. Say "continue" and I\'ll pick the task back up.'
              : '(Finished with nothing further to do.)' });
          }
          finish();
          return;
        }
        this.autoContinues = 0; // real progress was made; reset the stall guards
        this.emptyResponses = 0;
        for (const call of calls) {
          if (this.abortController?.signal.aborted) { return; } // stop between tools when the user hits Stop
          const result = await this.executeTool(call);
          this.emit({ type: 'toolResult', summary: summarizeResult(call.name, result) });
          this.messages.push({ role: 'tool', content: result, tool_call_id: call.id, name: call.name });
        }
      }
      throw new Error(`The agent reached its ${this.maxSteps}-step safety limit. Say "continue" to keep going, or raise techwordCode.maxSteps for very large tasks.`);
    } catch (error) {
      if (!this.abortController.signal.aborted) { guard.markSpent(); this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
    } finally {
      finish(); // covers user Stop, context-decline, and abort-between-tools — all of which return without a terminal event
      this.abortController = undefined;
    }
  }

  /**
   * Stream one model turn, retrying transient failures (network drop, timeout, mid-reply stall,
   * provider 5xx/429) FOREVER with capped backoff — so a long autonomous run never dies on a blip.
   * Only a terminal error (dead/expired key, tokens exhausted) or the user hitting Stop ends it:
   * terminal errors are re-thrown to the loop's catch (which shows them), abort returns undefined.
   * Any partial text streamed before a drop is discarded (resetStream) so the retry doesn't duplicate.
   */
  private async streamTurn(client: OpenAICompatibleClient): Promise<{ text: string; calls: ToolCall[]; stopReason: string | undefined; thinkingBlocks: ThinkingBlock[] } | undefined> {
    let attempt = 0;
    for (;;) {
      if (this.abortController?.signal.aborted) { return undefined; }
      let text = '';
      let calls: ToolCall[] = [];
      let stopReason: string | undefined;
      let thinkingBlocks: ThinkingBlock[] = [];
      let sawThinking = false;
      try {
        for await (const delta of client.streamCompletion(this.messages, this.activeTools(), this.abortController!.signal)) {
          if (delta.status) { this.emit({ type: 'status', message: delta.status }); }
          if (delta.thinking) { sawThinking = true; this.emit({ type: 'thinking', text: delta.thinking }); } // real reasoning → Activity
          if (delta.text) { text += delta.text; this.emit({ type: 'assistantDelta', text: delta.text }); }
          if (delta.toolCalls) { calls = delta.toolCalls; }
          if (delta.thinkingBlocks) { thinkingBlocks = delta.thinkingBlocks; }
          if (delta.stopReason) { stopReason = delta.stopReason; }
          if (delta.usage) { this.totalTokens += delta.usage.total; this.lastTurnTokens = delta.usage.total; this.emit({ type: 'usage', total: this.totalTokens, window: this.lastTurnTokens, limit: this.contextLimit }); }
        }
        return { text, calls, stopReason, thinkingBlocks };
      } catch (error) {
        if (this.abortController?.signal.aborted) { return undefined; }
        // The gateway can't do extended thinking. Turn it off (this run and future ones) and retry the
        // same turn on the normal path — no attempt spent, no error shown. The task never notices.
        if (error instanceof ThinkingUnsupportedError) {
          this.thinkingSupported = false;
          client.disableThinking();
          if (sawThinking) { this.emit({ type: 'resetStream' }); }
          continue;
        }
        if (isTerminalError(error)) { throw error; } // dead key / no tokens — must reach the user
        // Transient: keep trying until the connection comes back. Drop any half-streamed text first.
        if (text || sawThinking) { this.emit({ type: 'resetStream' }); }
        attempt += 1;
        const waitMs = Math.min(2 ** Math.min(attempt, 5) * 1000, 30000);
        // Reassure the user (or leave a clear trail on an unattended run): it is not stuck or stopped,
        // it is waiting for the connection and will resume on its own. Works the same when fully offline.
        // Uses the client's continuous counter so the number keeps climbing instead of resetting to 1.
        this.emit({ type: 'status', message: `Waiting for your connection — I'll keep retrying and continue automatically (attempt ${client.bumpAttempt()})…` });
        await this.sleepAbortable(waitMs);
      }
    }
  }

  private sleepAbortable(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abortController?.signal;
      if (signal?.aborted) { resolve(); return; }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); resolve(); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Fold any messages the user sent while working into the conversation. */
  private drainQueue(): void {
    if (this.queued.length === 0) { return; }
    for (const item of this.queued.splice(0)) {
      // Frame it so the model KNOWS this arrived mid-task and decides for itself whether to fold it
      // into the current work, finish first then do it, or treat it as a correction — instead of
      // silently appending it as if it were the original request.
      this.messages.push({ role: 'user', content: `[New message added while you were working] ${item.text}\n\n(Acknowledge this in one line — say whether you'll fold it into the current step or finish that first — then keep going. Don't restart work you've already done.)` });
      this.emit({ type: 'tool', name: 'user_message', detail: item.text });
    }
    this.emitQueued(); // now empty — clears the pending chips in the UI
  }

  stop(): void { this.queued = []; this.emitQueued(); this.answer('[The user stopped the task.]'); this.abortController?.abort(); }

  /** Keep the conversation within the context window. Returns false if the user chose to stop. */
  private async manageContext(client: OpenAICompatibleClient): Promise<boolean> {
    const estimate = this.lastTurnTokens || this.estimateTokens();
    if (estimate < this.contextLimit) { return true; }
    if (this.contextMode === 'ask') {
      const proceed = await this.gate({ id: randomUUID(), kind: 'command', command: 'Compact conversation and continue', cwd: `~${Math.round(estimate / 1000)}K tokens used of ${Math.round(this.contextLimit / 1000)}K`, purpose: 'The context window is nearly full. Approve to summarize earlier work and keep going without losing memory.' });
      if (!proceed) { this.emit({ type: 'status', message: 'Paused. Your chat is saved — reopen it any time to continue.' }); return false; }
    }
    await this.compact(client);
    return true;
  }

  /** Summarize older messages into a compact note so the window shrinks but the work is remembered. */
  private async compact(client: OpenAICompatibleClient): Promise<void> {
    const system = this.messages[0];
    const recent = this.messages.slice(-4);
    const older = this.messages.slice(1, -4);
    if (older.length === 0 || !system) { return; }
    this.emit({ type: 'status', message: 'Compacting context…' });
    const summaryRequest: ChatMessage[] = [
      system,
      ...older,
      { role: 'user', content: 'Summarize everything above so work can continue in a fresh context: the goal, key decisions, files created/modified, commands run and their outcomes, and what still needs doing. Preserve every fact needed to continue. Do not omit file paths.' }
    ];
    let summary = '';
    try {
      for await (const delta of client.streamCompletion(summaryRequest, [], this.abortController?.signal)) {
        if (delta.text) { summary += delta.text; }
      }
    } catch { return; /* if summarization fails, keep full history rather than lose it */ }
    if (!summary.trim()) { return; }
    this.messages = [system, { role: 'assistant', content: `[Summary of earlier work in this task]\n${summary}` }, ...recent.filter((message) => message.role !== 'system')];
    this.lastTurnTokens = 0;
    this.emit({ type: 'compacted', message: 'Context compacted — earlier work summarized, memory kept.' });
  }

  private estimateTokens(): number {
    let chars = 0;
    for (const message of this.messages) {
      chars += typeof message.content === 'string'
        ? message.content.length
        : message.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 2000), 0);
    }
    return Math.round(chars / 4);
  }

  /** Combine the prompt (with @mentions), attached text files, and images into one user message. */
  private async buildUserContent(prompt: string, attachments: Attachment[]): Promise<string | ContentPart[]> {
    let text = await this.resolveMentions(prompt);
    const images = attachments.filter((item) => item.kind === 'image' && item.dataUrl);
    const texts = attachments.filter((item) => item.kind === 'text' && item.text);
    for (const file of texts) { text += `\n\n--- ${file.name} ---\n${file.text}`; }
    if (images.length === 0) { return text; }
    const parts: ContentPart[] = [{ type: 'text', text }];
    for (const image of images) { parts.push({ type: 'image_url', image_url: { url: image.dataUrl as string } }); }
    return parts;
  }

  /** Answer pure identity questions directly so the product's name is always correct. */
  private identityAnswer(prompt: string): string | undefined {
    const p = prompt.trim();
    if (p.length > 160) { return undefined; }
    // "Who made/developed/owns you", "your developer", "how do I contact the developer" → reveal developer + contact.
    const asksDeveloper = /\b(who\s+(made|built|created|developed|designed|owns|trained)\s+you|who'?s\s+your\s+(developer|creator|maker|author|owner)|your\s+(developer|creator|maker|author|owner)|who\s+is\s+behind\s+(you|techword)|how\s+(can|do)\s+i\s+(contact|reach)\s+(you|the\s+developer|techword|denis)|contact\s+(the\s+)?(developer|techword))\b/i.test(p);
    if (asksDeveloper) {
      return "I'm Techword Code, developed by Denis Macharia. For anything about Techword Code, you can reach the developer on +254703285246.";
    }
    // General "who/what are you / your name / are you Kiro?" → name only, no developer details.
    const asksName = /\b(who\s+are\s+you|what\s+are\s+you|your\s+name|what'?s\s+your\s+name|are\s+you\s+(kiro|claude|gpt|chat\s?gpt|anthropic|openai|gemini|bard)|what\s+(ai|model|llm|assistant)\s+are\s+you|which\s+(ai|model|llm))\b/i.test(p);
    if (asksName) {
      return "I'm Techword Code, an AI coding assistant. I can explore your project, propose edits, run commands, and help you build, fix, and test code. What would you like to work on?";
    }
    return undefined;
  }

  /** Run one or more read-only sub-agents that explore the codebase and return distilled answers,
   *  keeping the main conversation's context clean (like Claude Code / Codex subagents).
   *  Multiple tasks run concurrently — real parallelism, since each streams its own HTTP request. */
  private async spawnExplorers(tasks: string[]): Promise<string> {
    const clean = tasks.map((task) => task.trim()).filter(Boolean).slice(0, 6);
    if (clean.length === 0) { throw new Error('spawn_explorer needs at least one task.'); }
    this.emit({ type: 'tool', name: 'spawn_explorer', detail: clean.length === 1 ? clean[0] as string : `${clean.length} explorers in parallel` });
    if (clean.length === 1) { return this.runExplorer(clean[0] as string, ''); }
    const results = await Promise.all(clean.map((task, index) => this.runExplorer(task, `#${index + 1} `)
      .catch((error) => `Explorer ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}`)));
    return clean.map((task, index) => `--- Explorer ${index + 1}: ${task}\n${results[index]}`).join('\n\n');
  }

  /** A single read-only exploration sub-agent. `tag` labels its activity when several run at once. */
  private async runExplorer(task: string, tag: string): Promise<string> {
    // Explorers are read-only summarizers — no reasoning UI, so don't spend thinking tokens on them.
    const client = new OpenAICompatibleClient(this.provider, this.apiKey, { ...this.genOptions, thinking: false });
    const tools = TOOLS.filter((tool) => READONLY_TOOLS.has(tool.name) && tool.name !== 'ask_user' && tool.name !== 'preview_in_chat' && tool.name !== 'spawn_explorer');
    const sub: ChatMessage[] = [
      { role: 'system', content: 'You are a read-only exploration sub-agent for Techword Code. Investigate the workspace with the available search/read/symbol tools and answer the given question concisely and completely. You cannot edit files or run commands. Return the specific findings the main agent needs (exact file paths, line numbers, symbol names, and a short explanation) — not a plan.' },
      { role: 'user', content: task }
    ];
    let findings = '';
    for (let turn = 0; turn < 15; turn += 1) {
      if (this.abortController?.signal.aborted) { break; }
      let text = '';
      let calls: ToolCall[] = [];
      for await (const delta of client.streamCompletion(sub, tools, this.abortController?.signal)) {
        if (delta.text) { text += delta.text; }
        if (delta.toolCalls) { calls = delta.toolCalls; }
        if (delta.usage) { this.totalTokens += delta.usage.total; this.emit({ type: 'usage', total: this.totalTokens }); }
      }
      if (text.trim()) { findings = text; }
      if (calls.length === 0) { break; }
      sub.push({ role: 'assistant', content: text, tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
      for (const call of calls) {
        this.emit({ type: 'tool', name: call.name, detail: `${tag}explorer: ${JSON.stringify(call.arguments).slice(0, 80)}` });
        const result = await this.executeTool(call);
        this.emit({ type: 'toolResult', summary: summarizeResult(call.name, result) });
        sub.push({ role: 'tool', content: result, tool_call_id: call.id, name: call.name });
      }
    }
    return findings.trim() || 'The exploration finished without a clear answer.';
  }

  /** Inline any @path references in the prompt by attaching those files' contents. */
  private async resolveMentions(prompt: string): Promise<string> {
    const paths = [...prompt.matchAll(/(?:^|\s)@([^\s]+)/g)].map((match) => match[1]).filter((path): path is string => Boolean(path)).slice(0, 5);
    if (paths.length === 0) { return prompt; }
    const blocks: string[] = [];
    for (const path of paths) {
      try { blocks.push(`--- ${path} ---\n${await this.executor.readFile(path, 1, 400)}`); } catch { /* skip unreadable mentions */ }
    }
    return blocks.length > 0 ? `${prompt}\n\nReferenced files:\n${blocks.join('\n\n')}` : prompt;
  }

  private async executeTool(call: ToolCall): Promise<string> {
    const args = call.arguments;
    if (this.mode === 'plan' && !READONLY_TOOLS.has(call.name)) {
      return 'You are in Plan mode (read-only). Do not edit files or run commands. Instead, present a clear step-by-step plan and ask the user to switch to Act mode to carry it out.';
    }
    try {
      switch (call.name) {
        case 'list_workspace_files':
          this.emit({ type: 'tool', name: call.name, detail: stringArg(args, 'path', '.') });
          return await this.executor.listFiles(stringArg(args, 'path', '.'), numberArg(args, 'depth', 3));
        case 'read_file':
          this.emit({ type: 'tool', name: call.name, detail: requiredString(args, 'path') });
          return await this.executor.readFile(requiredString(args, 'path'), numberArg(args, 'startLine', 1), numberArg(args, 'endLine', 400));
        case 'get_git_status':
          this.emit({ type: 'tool', name: call.name, detail: 'git status' });
          return await this.executor.gitStatus();
        case 'get_git_diff':
          this.emit({ type: 'tool', name: call.name, detail: 'git diff' });
          return await this.executor.gitDiff(stringArg(args, 'path', ''));
        case 'get_diagnostics':
          this.emit({ type: 'tool', name: call.name, detail: stringArg(args, 'path', 'workspace') });
          return this.executor.getDiagnostics(stringArg(args, 'path', ''), boolArg(args, 'errorsOnly', false));
        case 'find_symbol':
          this.emit({ type: 'tool', name: call.name, detail: requiredString(args, 'query') });
          return await this.executor.findSymbol(requiredString(args, 'query'));
        case 'outline_file':
          this.emit({ type: 'tool', name: call.name, detail: requiredString(args, 'path') });
          return await this.executor.outlineFile(requiredString(args, 'path'));
        case 'find_usages':
          this.emit({ type: 'tool', name: call.name, detail: `${requiredString(args, 'path')}:${numberArg(args, 'line', 1)}` });
          return await this.executor.findUsages(requiredString(args, 'path'), numberArg(args, 'line', 1), stringArg(args, 'symbol', ''));
        case 'web_fetch':
          this.emit({ type: 'tool', name: call.name, detail: requiredString(args, 'url') });
          return await this.executor.webFetch(requiredString(args, 'url'));
        case 'preview_in_chat': {
          const previewPath = requiredString(args, 'path');
          this.emit({ type: 'tool', name: call.name, detail: previewPath });
          const preview = await this.executor.previewDataUrl(previewPath);
          this.emit({ type: 'preview', dataUrl: preview.dataUrl, name: preview.name });
          return `Displayed ${preview.name} in the chat for the user to see.`;
        }
        case 'ask_user': {
          const question = requiredString(args, 'question');
          const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).slice(0, 6) : undefined;
          this.emit({ type: 'question', text: question, options: options && options.length > 0 ? options : undefined });
          this.emit({ type: 'status', message: 'Waiting for your answer…' });
          return await new Promise<string>((resolve) => { this.questionResolver = (answer) => resolve(`The user answered: ${answer}`); });
        }
        case 'spawn_explorer': {
          const many = Array.isArray(args.tasks) ? args.tasks.filter((t): t is string => typeof t === 'string') : [];
          const tasks = many.length > 0 ? many : [requiredString(args, 'task')];
          return await this.spawnExplorers(tasks);
        }
        case 'code_map':
          this.emit({ type: 'tool', name: call.name, detail: stringArg(args, 'path', 'workspace') });
          return await this.executor.codeMap(stringArg(args, 'path', ''), numberArg(args, 'maxFiles', 120));
        case 'remember': {
          if (!this.memorySink) { return 'Memory is unavailable right now.'; }
          const scope = args.scope === 'global' ? 'global' : args.scope === 'project' ? 'project' : undefined;
          this.emit({ type: 'tool', name: call.name, detail: requiredString(args, 'text') });
          return await this.memorySink.remember(requiredString(args, 'text'), scope);
        }
        case 'forget': {
          if (!this.memorySink) { return 'Memory is unavailable right now.'; }
          this.emit({ type: 'tool', name: call.name, detail: requiredString(args, 'query') });
          return await this.memorySink.forget(requiredString(args, 'query'));
        }
        case 'search_workspace':
          this.emit({ type: 'tool', name: call.name, detail: requiredString(args, 'query') });
          return await this.executor.searchText(requiredString(args, 'query'), { regex: boolArg(args, 'regex', false), include: stringArg(args, 'include', ''), maxResults: numberArg(args, 'maxResults', 100) });
        case 'edit_file': {
          const path = requiredString(args, 'path');
          const rawEdits = Array.isArray(args.edits) ? args.edits : [];
          const stringEdits = rawEdits.map((item) => {
            const edit = (item ?? {}) as Record<string, unknown>;
            return { oldText: typeof edit.oldText === 'string' ? edit.oldText : '', newText: typeof edit.newText === 'string' ? edit.newText : '', replaceAll: edit.replaceAll === true };
          });
          const fileEdit = await this.executor.computeStringEdit(path, stringEdits);
          return await this.approveEdits([fileEdit], stringArg(args, 'summary', `Edit ${path}`));
        }
        case 'propose_file_edits':
          return await this.approveEdits(parseEdits(args), stringArg(args, 'summary', 'Proposed file changes'));
        case 'run_terminal_command':
          return await this.approveCommand({ command: requiredString(args, 'command'), cwd: stringArg(args, 'cwd', ''), purpose: requiredString(args, 'purpose'), timeoutMs: numberArg(args, 'timeoutMs', 120000) });
        default:
          if (this.mcp && call.name.startsWith('mcp__')) { return await this.approveMcp(call.name, args); }
          return `Tool error: ${call.name} is unavailable.`;
      }
    } catch (error) {
      return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async approveEdits(edits: FileEdit[], summary: string): Promise<string> {
    if (edits.length === 0 || edits.length > 20) { throw new Error('A proposal must contain 1–20 edits.'); }
    const previews = await this.executor.buildPreviews(edits);
    const approval = this.approvals.request(edits);
    const id = randomUUID();
    this.emit({ type: 'tool', name: 'propose_file_edits', detail: `${edits.length} file change(s)` });
    const approved = await this.gate({ id, kind: 'edits', summary, previews });
    if (!approved || !this.approvals.consume(approval.id, edits)) { return 'The user rejected the proposed file changes.'; }
    const checkpointId = await this.executor.applyEdits(edits);
    this.emit({ type: 'checkpoint', id: checkpointId, summary: edits.map((edit) => edit.path).join(', ') });
    return `Approved and applied changes: ${edits.map((edit) => edit.path).join(', ')}`;
  }

  /** Undo a previously applied edit set. */
  async restoreCheckpoint(id: string): Promise<string> {
    const result = await this.executor.restoreCheckpoint(id);
    this.emit({ type: 'status', message: result });
    return result;
  }

  private async approveCommand(proposal: CommandProposal): Promise<string> {
    const approval = this.approvals.request(proposal);
    const id = randomUUID();
    this.emit({ type: 'tool', name: 'run_terminal_command', detail: proposal.command });
    const approved = await this.gate({ id, kind: 'command', command: proposal.command, cwd: proposal.cwd || 'workspace root', purpose: proposal.purpose });
    if (!approved || !this.approvals.consume(approval.id, proposal)) { return 'The user rejected the terminal command.'; }
    return this.executor.runCommand(proposal, this.abortController?.signal);
  }

  /** Call an external MCP tool, gated by user approval since these servers can have side effects. */
  private async approveMcp(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    if (!this.mcp) { return 'Tool error: MCP is not available.'; }
    const tool = this.mcp.getTool(qualifiedName);
    if (!tool) { return `Tool error: ${qualifiedName} is not a known MCP tool.`; }
    const argsJson = JSON.stringify(args);
    const proposal: CommandProposal = { command: `MCP ${tool.server}: ${tool.toolName}`, purpose: `Call the "${tool.toolName}" tool on MCP server "${tool.server}" with ${argsJson.slice(0, 200)}` };
    const approval = this.approvals.request(proposal);
    const id = randomUUID();
    this.emit({ type: 'tool', name: qualifiedName, detail: `${tool.server}: ${tool.toolName}` });
    const approved = await this.gate({ id, kind: 'mcp', server: tool.server, tool: tool.toolName, argsJson: argsJson.slice(0, 2000) });
    if (!approved || !this.approvals.consume(approval.id, proposal)) { return 'The user rejected the MCP tool call.'; }
    return this.mcp.callTool(qualifiedName, args);
  }
}

/** Heuristic: does the assistant's text announce a next action it hasn't taken yet (a "cliffhanger"
 *  that would otherwise leave the task hanging)? Kept conservative so genuine sign-offs don't loop. */
export function intendsToContinue(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) { return true; } // blank reply: the model produced nothing — unfinished, let the caller nudge/retry
  const tail = trimmed.slice(-240).toLowerCase();
  // A genuine hand-back to the user, not a stall. Checked FIRST so a conversational reply that happens to
  // contain "let me"/"I'll" ("Hi! Let me know…", "I'll be happy to help you") never counts as a cliffhanger.
  if (/\b(let me know|would you like|do you want|shall i|should i|which (one|option)|let (us|'s) know|any questions|is that (ok|okay)|confirm before|feel free|happy to help|how can i help|what would you like|help you|assist you|here to help|glad to help|anything else)\b/.test(tail)) { return false; }
  if (/\?\s*$/.test(tail)) { return false; } // ends on a question to the user
  // A forward-looking action announcement ("let me…", "now I'll…", "I will…", "about to…") means the model
  // SAID it would do something. If the turn then produced no tool call, that's a cliffhanger worth nudging —
  // whether or not the sentence is punctuated. Punctuation alone doesn't tell a cliffhanger from a finish
  // ("Let me check the repo state." is unfinished; "The build is green." is done) — the action verb does.
  if (/(^|[\s"'—-])(let me|i'?ll|i will|i'?m going to|i am going to|now i'?ll|next,? i|first,? i|then i'?ll|i'?m about to|about to|proceeding to|starting to)\b/.test(tail)) { return true; }
  if (/[:：]\s*$/.test(trimmed)) { return true; } // trailing colon usually precedes an action/list
  return false;
}

export type EmptyTurnAction = 'continue-truncated' | 'retry-empty' | 'fail-empty' | 'nudge' | 'complete';

/** How many fully-empty turns to tolerate before giving up. High so long autonomous runs survive a
 *  bad patch of dropped turns, bounded so a malformed request can't loop forever with no progress. */
export const EMPTY_RESPONSE_LIMIT = 12;

/** How many times to nudge a model that announces a step ("I'll map the codebase…") but doesn't call
 *  the tool. Set high on purpose: the user proved a couple of manual retries gets it acting, so the
 *  agent should push at least as hard by itself — never give up after a handful and stop half-started.
 *  Still bounded so a provider that CAN'T tool-call can't spin forever with zero progress. */
export const STALL_NUDGE_LIMIT = 25;

/** Decide what to do when the model's turn produced NO tool call. This is the logic that decides
 *  "keep going" vs "done", using the provider's real stop_reason instead of guessing from prose —
 *  so a reply cut off at the token limit continues, a dropped/empty reply retries then errors
 *  (never a silent stop), a cliffhanger gets nudged, and only a genuine finish completes. */
export function decideAfterEmptyTurn(opts: {
  mode: 'plan' | 'act';
  text: string;
  stopReason: string | undefined;
  autoContinues: number;
  emptyResponses: number;
}): EmptyTurnAction {
  // Cut off at the output-token limit — the turn is unfinished, continue it. Highest priority so a
  // truncated reply that happens to end mid-word is never mistaken for a stall or a completion.
  if (opts.stopReason === 'max_tokens') { return 'continue-truncated'; }
  // The stream yielded nothing at all (no text, no stop reason): the provider dropped the turn.
  // Retry persistently — an autonomous run on a big project shouldn't die on a few dropped turns —
  // but keep a ceiling so a genuinely malformed request can't spin forever with zero progress.
  if (!opts.text.trim() && !opts.stopReason) { return opts.emptyResponses < EMPTY_RESPONSE_LIMIT ? 'retry-empty' : 'fail-empty'; }
  // Stopped mid-thought without acting: nudge it to actually call the tool (Act mode). Keep nudging
  // persistently — the user showed that retrying a few times gets it acting, so don't quit after a
  // handful. Bounded by STALL_NUDGE_LIMIT so a provider that truly can't tool-call still terminates.
  if (opts.mode === 'act' && intendsToContinue(opts.text) && opts.autoContinues < STALL_NUDGE_LIMIT) { return 'nudge'; }
  // A clean, genuine finish.
  return 'complete';
}

/** Escalating nudge text for a model that keeps announcing steps without calling a tool. Gentle at
 *  first, then increasingly blunt — the later messages ban prose entirely so a genuine tool call is the
 *  only response left. `n` is the 1-based nudge attempt. Exported so the escalation is unit-tested. */
export function nudgeMessage(n: number): string {
  if (n <= 1) { return 'Continue. Carry out the next step now by calling the appropriate tool — do not stop until the task is complete and verified. If you truly need my input, call ask_user; if the task is genuinely finished, say so with a short final summary.'; }
  if (n <= 3) { return 'You described what you would do but did not do it. Call the tool now. Do not restate the plan — act on it. If the task is actually finished, give a one-line final summary; if you need my input, call ask_user.'; }
  return 'Stop describing and act. Your ONLY valid next output is a tool call that makes real progress on the task — no prose, no plan, no restating. (If and only if the task is genuinely complete, reply with a short final summary; if you truly cannot proceed without me, call ask_user.)';
}

/** Guarantees the UI gets EXACTLY ONE terminal signal per task, no matter how the run loop exits.
 *  The bug this prevents: the working bar's animation only stops on a terminal event, but several
 *  loop exits (user Stop, context-decline, abort between tools) used to `return` without emitting one,
 *  so the bar animated forever with no way to clear it. `finish()` fires the terminal callback the
 *  first time only; `markSpent()` records that a DIFFERENT terminal event (an error) already went out,
 *  so the guaranteeing `finish()` in `finally` won't double-fire. Exported so the invariant is tested. */
export function createTerminalGuard(onFinish: () => void): { finish: () => void; markSpent: () => void; get spent(): boolean } {
  let spent = false;
  return {
    finish: (): void => { if (!spent) { spent = true; onFinish(); } },
    markSpent: (): void => { spent = true; },
    get spent(): boolean { return spent; },
  };
}

function requiredString(value: Record<string, unknown>, key: string): string { const item = value[key]; if (typeof item !== 'string' || !item.trim()) { throw new Error(`${key} is required.`); } return item; }
function stringArg(value: Record<string, unknown>, key: string, fallback: string): string { const item = value[key]; return typeof item === 'string' ? item : fallback; }
function numberArg(value: Record<string, unknown>, key: string, fallback: number): number { const item = value[key]; return typeof item === 'number' && Number.isFinite(item) ? item : fallback; }
function boolArg(value: Record<string, unknown>, key: string, fallback: boolean): boolean { const item = value[key]; return typeof item === 'boolean' ? item : fallback; }

/** One short line describing what a tool produced, for the activity log. */
function summarizeResult(name: string, result: string): string {
  const text = result.trim();
  if (/^Tool error:|^The user rejected/i.test(text)) { return text.split('\n')[0]?.slice(0, 140) ?? ''; }
  const lines = text ? text.split('\n').length : 0;
  switch (name) {
    case 'read_file': return `Read ${lines} line${lines === 1 ? '' : 's'}`;
    case 'search_workspace': return /no matches/i.test(text) ? 'No matches' : `${text.split('\n').filter(Boolean).length} match(es)`;
    case 'list_workspace_files': return `${text.split('\n').filter(Boolean).length} file(s)`;
    case 'edit_file': case 'propose_file_edits': return text.split('\n')[0]?.slice(0, 140) ?? 'Done';
    case 'run_terminal_command': return text ? `Output: ${text.split('\n')[0]?.slice(0, 120)}` : 'Command finished';
    case 'get_diagnostics': return /no problems/i.test(text) ? 'No problems' : `${text.split('\n').filter(Boolean).length} problem(s)`;
    case 'get_git_status': case 'get_git_diff': return text ? `${lines} line(s)` : 'Clean';
    default: return 'Done';
  }
}
