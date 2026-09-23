import * as vscode from 'vscode';
import { AgentSession, type ContextMode, type MemorySink } from '../agent/AgentSession';
import { ConversationStore } from '../agent/ConversationStore';
import { MemoryStore } from '../agent/MemoryStore';
import { filesTouched } from '../agent/ConversationInsights';
import type { ProviderRegistry } from '../providers/ProviderRegistry';
import { OpenAICompatibleClient } from '../providers/OpenAICompatibleClient';
import { ApprovalBroker } from '../security/ApprovalBroker';
import { WorkspaceToolExecutor } from '../tools/WorkspaceToolExecutor';
import { WorktreeManager } from '../agent/WorktreeManager';
import { classifyCommand } from '../security/CommandPolicy';
import { McpHub } from '../mcp/McpHub';
import { labelForModel } from '../TechwordConfig';
import type { AgentEvent, ApprovalRequest, Attachment, ChatMessage, ContentPart, ConversationMeta, McpServerConfig, StoredConversation } from '../types';

interface DisplayItem { role: 'user' | 'assistant'; text: string; }

/** Messages the extension posts to the webview. */
type OutMessage =
  | { kind: 'state'; connected: boolean; hasKey: boolean; keyHint?: string; models: Array<{ id: string; label: string }>; selectedModel?: string; running: boolean; mode: 'plan' | 'act'; autoApprove: { edits: boolean; commands: boolean }; agentMode: 'manual' | 'edit' | 'plan' | 'bypass'; mcp: Array<{ server: string; running: boolean; toolCount: number; error?: string }> }
  | { kind: 'status'; message: string }
  | { kind: 'delta'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'resetStream' }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'commandOutput'; chunk: string }
  | { kind: 'toolResult'; summary: string }
  | { kind: 'cmdResult'; token: string; output: string; failed: boolean }
  | { kind: 'checkpoint'; id: string; summary: string }
  | { kind: 'question'; text: string; options?: string[] }
  | { kind: 'queued'; items: Array<{ id: string; text: string }> }
  | { kind: 'preview'; dataUrl: string; name: string }
  | { kind: 'compacted'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'complete' }
  | { kind: 'approvalRequest'; request: ApprovalRequest; auto: boolean; warning?: string }
  | { kind: 'approvalResolved'; id: string; approved: boolean }
  | { kind: 'usage'; total: number; window?: number; limit?: number; usdPerMillion?: number; showCost?: boolean }
  | { kind: 'billing'; spentUsd: number; limitUsd?: number; meterInCents: boolean }
  | { kind: 'connection'; ok: boolean; message: string; latencyMs?: number; models?: string[] }
  | { kind: 'attachments'; items: Array<{ id: string; name: string; kind: 'image' | 'text'; dataUrl?: string }> }
  | { kind: 'history'; items: ConversationMeta[]; currentId?: string }
  | { kind: 'renamed'; title: string }
  | { kind: 'load'; items: DisplayItem[]; title: string };

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

type OutputStyle = 'default' | 'concise' | 'explanatory' | 'code';

/** What each output style tells the model. Injected into the system prompt's project block. */
const OUTPUT_STYLE_TEXT: Record<OutputStyle, string> = {
  default: '',
  concise: 'Keep replies short and to the point. Skip preamble and recap. Report what changed in one or two sentences. Prefer bullet points over paragraphs.',
  explanatory: 'Explain your reasoning as you work: why you chose an approach, trade-offs you weighed, and how the pieces fit together, so the user learns from the change. Still keep it readable.',
  code: 'Respond with code and minimal prose. Show the code changes and only the essential note about what they do. Avoid long explanations unless asked.'
};

const OUTPUT_STYLE_OPTIONS: Array<{ id: OutputStyle; label: string; description: string }> = [
  { id: 'default', label: 'Default', description: 'Balanced explanations, proportional to the task' },
  { id: 'concise', label: 'Concise', description: 'Short answers, minimal preamble' },
  { id: 'explanatory', label: 'Explanatory', description: 'Teaches as it works, explains trade-offs' },
  { id: 'code', label: 'Code-focused', description: 'Mostly code, little prose' }
];


export class AgentViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'techwordCode.chat';
  private view: vscode.WebviewView | undefined;
  private session: AgentSession | undefined;
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  private pendingAttachments: Attachment[] = [];
  private readonly store: ConversationStore;
  private readonly memory: MemoryStore;
  private conversationId: string = crypto.randomUUID();
  private conversationCreatedAt: number = Date.now();
  /** Debounce handle + write-serialization chain for incremental history saves (see scheduleSave/saveCurrent). */
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  /** Set when the user renames the current chat, so saveCurrent() keeps it instead of re-deriving from the first message. */
  private customTitle: string | undefined;
  private autoApprove: { edits: boolean; commands: boolean };
  private mode: 'plan' | 'act' = 'act';
  /** Live override for extended thinking, driven by the Brain toggle in the panel. undefined = follow the
   *  showThinking setting (default off, for speed); true/false = the user turned reasoning on/off this session. */
  private thinkingOn: boolean | undefined;
  private readonly mcp = new McpHub((message) => this.post({ kind: 'status', message }));

  constructor(private readonly context: vscode.ExtensionContext, private readonly providers: ProviderRegistry) {
    this.store = new ConversationStore(context);
    this.memory = new MemoryStore(context);
    // Per-workspace so a project you trust stays trusted, and others don't inherit it. Default off.
    this.autoApprove = context.workspaceState.get<{ edits: boolean; commands: boolean }>('techwordCode.autoApprove', { edits: false, commands: false });
    context.subscriptions.push({ dispose: () => this.mcp.dispose() });
    // Kill any background commands the agent started (dev server, build) so they aren't orphaned on close.
    context.subscriptions.push({ dispose: () => this.session?.dispose() });
    // Best-effort flush on shutdown: if a turn is mid-flight when VS Code closes, write what we have now.
    // VS Code doesn't await async disposables, so this is a safety net on top of the debounced mid-turn
    // save (scheduleSave) — that keeps worst-case loss to a fraction of a second, this catches the rest.
    context.subscriptions.push({ dispose: () => { void this.saveCurrent(); } });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => { void this.handleMessage(message); }, undefined, this.context.subscriptions);
    void this.postState();
  }

  focus(): void { void vscode.commands.executeCommand('techwordCode.chat.focus'); }
  submit(prompt: string): void { void this.startTask(prompt); }

  stop(): void {
    this.session?.stop();
    for (const [id, resolve] of this.pendingApprovals) { resolve(false); this.post({ kind: 'approvalResolved', id, approved: false }); }
    this.pendingApprovals.clear();
  }

  private post(message: OutMessage): void { void this.view?.webview.postMessage(message); }

  /** Cost-display settings for the usage counter: whether to show USD, the estimate rate per million
   *  tokens (fallback before the real meter is read), and whether the provider's meter is in cents. */
  private costConfig(): { showCost: boolean; usdPerMillion: number; meterInCents: boolean } {
    const config = vscode.workspace.getConfiguration('techwordCode');
    return {
      showCost: config.get<boolean>('showCostInUsd', true),
      usdPerMillion: config.get<number>('usdPerMillionTokens', 1.6111),
      meterInCents: config.get<boolean>('usageMeterInCents', true),
    };
  }

  private emit(event: AgentEvent): void {
    switch (event.type) {
      case 'status': this.post({ kind: 'status', message: event.message }); break;
      case 'assistantDelta': this.post({ kind: 'delta', text: event.text }); break;
      case 'resetStream': this.post({ kind: 'resetStream' }); break;
      case 'tool': this.post({ kind: 'tool', name: event.name, detail: event.detail }); break;
      case 'commandOutput': this.post({ kind: 'commandOutput', chunk: event.chunk }); break; // live terminal output, streamed faded under the command card
      case 'toolResult': this.post({ kind: 'toolResult', summary: event.summary }); this.scheduleSave(); break; // persist mid-turn — a tool round just landed in history
      case 'checkpoint': this.post({ kind: 'checkpoint', id: event.id, summary: event.summary }); this.scheduleSave(); break;
      case 'question': this.post({ kind: 'question', text: event.text, options: event.options }); break;
      case 'preview': this.post({ kind: 'preview', dataUrl: event.dataUrl, name: event.name }); break;
      case 'usage': { const c = this.costConfig(); this.post({ kind: 'usage', total: event.total, window: event.window, limit: event.limit, usdPerMillion: c.usdPerMillion, showCost: c.showCost }); break; }
      case 'billing': this.post({ kind: 'billing', spentUsd: event.spentUsd, limitUsd: event.limitUsd, meterInCents: event.meterInCents }); break;
      case 'compacted': this.post({ kind: 'compacted', message: event.message }); this.scheduleSave(); break; // context was rewritten — persist so a reload doesn't lose the summary
      case 'queued': this.post({ kind: 'queued', items: event.items }); break;
      case 'thinking': this.post({ kind: 'thinking', text: event.text }); break; // real reasoning → Activity panel
      case 'error': this.post({ kind: 'error', message: event.message }); break;
      case 'complete': this.post({ kind: 'complete' }); break;
    }
  }

  private requestApproval(request: ApprovalRequest): Promise<boolean> {
    // Auto-approve applies to edits (Edit mode) and commands/MCP (Bypass mode). But a genuinely
    // dangerous command (rm -rf, disk format, fork bomb, curl|sh, force push…) is NEVER auto-run — not
    // even in Bypass. This matches CommandPolicy's contract and stops an injected instruction in the
    // repo/tool output from silently detonating a destructive command overnight. Such a command still
    // appears in chat with a warning; the human must click. Everything else runs unattended as before.
    let auto = (request.kind === 'edits' && this.autoApprove.edits) || ((request.kind === 'command' || request.kind === 'mcp') && this.autoApprove.commands);
    let warning: string | undefined;
    if (request.kind === 'command') {
      const blocked = vscode.workspace.getConfiguration('techwordCode').get<string[]>('blockedCommands', []);
      const verdict = classifyCommand(request.command, blocked);
      if (verdict.level === 'blocked') {
        auto = false;
        warning = verdict.reason ? `Blocked from auto-run: ${verdict.reason}. Review carefully before approving.` : 'Potentially dangerous — review carefully before approving.';
      }
    }
    this.post({ kind: 'approvalRequest', request, auto, warning });
    if (auto) { return Promise.resolve(true); } // still shown in chat, just not gated on a click
    return new Promise<boolean>((resolve) => { this.pendingApprovals.set(request.id, resolve); });
  }

  private async ensureSession(): Promise<AgentSession | undefined> {
    const provider = this.providers.active();
    if (!provider) {
      void vscode.window.showInformationMessage('Connect your Techword API key first.', 'Connect Techword API')
        .then((choice) => choice && vscode.commands.executeCommand('techwordCode.configureProvider'));
      return undefined;
    }
    const apiKey = await this.providers.getApiKey();
    if (!apiKey) { return undefined; }
    const config = vscode.workspace.getConfiguration('techwordCode');
    if (!this.session) {
      const limit = config.get<number>('maxToolOutputChars', 12000);
      // Worktree support lets worker agents edit + test in isolation (only when a workspace folder is
      // open — the worktrees live under a temp dir but are created from this repo). Each worker gets an
      // executor rooted at its worktree; the main agent integrates results back through the approval gate.
      const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const worktrees = repoRoot
        ? { manager: new WorktreeManager(repoRoot), makeExecutor: (dir: string) => new WorkspaceToolExecutor(limit, dir) }
        : undefined;
      this.session = new AgentSession(provider, apiKey, new WorkspaceToolExecutor(limit), new ApprovalBroker(), (event) => this.emit(event), (request) => this.requestApproval(request), worktrees);
    } else {
      this.session.setProvider(provider); this.session.setApiKey(apiKey);
    }
    this.session.setContext(config.get<ContextMode>('contextMode', 'auto'), config.get<number>('contextTokenLimit', 120000));
    this.session.setMaxSteps(config.get<number>('maxSteps', 100));
    this.session.setGenerationOptions({ maxTokens: config.get<number>('maxTokens', 8192), temperature: config.get<number>('temperature', 0), thinking: this.thinkingOn ?? config.get<boolean>('showThinking', false), thinkingBudget: config.get<number>('thinkingBudget', 2048) });
    this.session.setWebFetchEnabled(config.get<boolean>('enableWebFetch', true));
    this.session.setCostOptions(config.get<boolean>('showCostInUsd', true), config.get<boolean>('usageMeterInCents', true));
    this.session.setMode(this.mode);
    this.session.setProjectRules(await this.composeRules(config));
    this.session.setMemorySink(this.memorySink());
    this.session.setMemory(await this.memory.compose());
    await this.syncMcp(config);
    this.session.setMcpHub(this.mcp);
    return this.session;
  }

  /** Start/stop MCP servers to match the techwordCode.mcpServers setting. Failures are surfaced, not fatal. */
  private async syncMcp(config: vscode.WorkspaceConfiguration): Promise<void> {
    const servers = config.get<Record<string, McpServerConfig>>('mcpServers', {});
    try { await this.mcp.sync(servers && typeof servers === 'object' ? servers : {}); }
    catch (error) { this.post({ kind: 'status', message: `MCP setup problem: ${error instanceof Error ? error.message : String(error)}` }); }
  }

  /** Open a workspace file in the editor (foreground) when the user clicks a file chip in the chat. */
  private async openFile(path: string, line?: number): Promise<void> {
    // Resolve chips against whatever the file tools are actually rooted at: a folder opened via
    // open_folder wins, otherwise the first workspace folder. Otherwise a chip for a file the agent
    // edited inside an opened folder would resolve against the wrong root and read as "no longer here".
    const overrideDir = this.session?.workingFolder;
    const baseUri = overrideDir ? vscode.Uri.file(overrideDir) : vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!baseUri) { this.post({ kind: 'error', message: 'No folder is open yet — give Techword a folder to work in first.' }); return; }
    const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || clean.split('/').includes('..')) { return; }
    const uri = vscode.Uri.joinPath(baseUri, clean);
    // Check the file still exists before opening. A chip can point at a file that was since deleted,
    // moved, or was only ever read from a temp/ref folder — clicking it should say so plainly, not
    // spill a raw ENOENT / "Unable to resolve nonexistent file" error into the chat.
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      this.post({ kind: 'status', message: `${clean} is no longer here — it may have been moved or deleted since it was opened.` });
      return;
    }
    try {
      const options: vscode.TextDocumentShowOptions = { preview: false, viewColumn: vscode.ViewColumn.One };
      if (line && line > 0) { const pos = new vscode.Position(line - 1, 0); options.selection = new vscode.Range(pos, pos); }
      await vscode.window.showTextDocument(uri, options);
    } catch (error) {
      this.post({ kind: 'status', message: `Couldn't open ${clean}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** Header window controls. Sidebar webviews can't do OS min/max, so these map to the closest safe
   *  layout commands: expand the view much wider (full-screen feel) / restore, and hide the panel. */
  private async layout(action: string): Promise<void> {
    try {
      if (action === 'expand') { for (let i = 0; i < 8; i += 1) { await vscode.commands.executeCommand('workbench.action.increaseViewSize'); } }
      else if (action === 'restore') { for (let i = 0; i < 8; i += 1) { await vscode.commands.executeCommand('workbench.action.decreaseViewSize'); } }
      else if (action === 'minimize') { await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility'); }
    } catch { /* layout commands are best-effort; ignore if unavailable */ }
  }

  /** Open an integrated terminal in the workspace root. */
  private async openTerminal(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({ name: 'Techword', cwd });
    terminal.show();
  }

  /** Run a command the user clicked in a chat code block. It shows in the integrated terminal (so the
   *  user sees it happen live) AND runs captured so the output can be streamed back into chat as faded
   *  text under the command — like Claude Code. The user's click is the confirmation; no extra prompt. */
  private async runChatCommand(command: string, token: string): Promise<void> {
    // The command text comes from model output, so a Run click on a genuinely dangerous command must
    // confirm first (the click alone shouldn't detonate an rm -rf the model happened to print). Ordinary
    // commands run straight away — the click is the confirmation.
    const blocked = vscode.workspace.getConfiguration('techwordCode').get<string[]>('blockedCommands', []);
    const verdict = classifyCommand(command, blocked);
    if (verdict.level === 'blocked') {
      const proceed = await vscode.window.showWarningMessage(
        'Run this command?',
        { modal: true, detail: `This looks dangerous${verdict.reason ? ` — ${verdict.reason}` : ''}:\n\n${command}\n\nOnly run it if you are certain.` },
        'Run anyway'
      );
      if (proceed !== 'Run anyway') { this.post({ kind: 'cmdResult', token, output: 'Cancelled — command not run.', failed: false }); return; }
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // Echo it into a visible terminal so the run is transparent (this is the "runs in the terminal" part).
    try { const terminal = vscode.window.createTerminal({ name: 'Techword', cwd }); terminal.show(); terminal.sendText(command, true); } catch { /* terminal is best-effort */ }
    // Capture the same command so we can show its result inline. Reuses the executor's safe, redacted runner.
    try {
      const executor = new WorkspaceToolExecutor(vscode.workspace.getConfiguration('techwordCode').get<number>('maxToolOutputChars', 12000));
      const output = await executor.runCommand({ command, purpose: 'Run from chat', timeoutMs: 600000 });
      // runCommand tags failures with an exit code / start failure / timeout marker — surface those in red.
      const failed = /\(exit code \d+\)|failed to start|timed out after/i.test(output);
      this.post({ kind: 'cmdResult', token, output, failed });
    } catch (error) {
      this.post({ kind: 'cmdResult', token, output: error instanceof Error ? error.message : String(error), failed: true });
    }
  }

  /** Show the Source Control view so the user can see the diff of everything Techword changed. */
  private async showChanges(): Promise<void> {
    try { await vscode.commands.executeCommand('workbench.view.scm'); }
    catch { await vscode.commands.executeCommand('workbench.scm.focus'); }
  }

  /** Preview the active file: Markdown/HTML render if possible, otherwise just open it side-by-side. */
  private async preview(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { this.post({ kind: 'error', message: 'Open a file first, then press Preview.' }); return; }
    const lang = editor.document.languageId;
    try {
      if (lang === 'markdown') { await vscode.commands.executeCommand('markdown.showPreviewToSide'); return; }
      if (lang === 'html') { await vscode.commands.executeCommand('vscode.open', editor.document.uri, vscode.ViewColumn.Beside); return; }
      await vscode.commands.executeCommand('vscode.open', editor.document.uri, vscode.ViewColumn.Beside);
    } catch (error) {
      this.post({ kind: 'error', message: `Could not preview: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** Load repo instruction files (AGENTS.md, .techwordrules, CLAUDE.md) to steer the agent. */
  private async readProjectRules(): Promise<string> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return ''; }
    const blocks: string[] = [];
    for (const name of ['AGENTS.md', '.techwordrules', 'CLAUDE.md']) {
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name));
        const text = Buffer.from(data).toString('utf8').trim();
        if (text) { blocks.push(`## ${name}\n${text.slice(0, 8000)}`); }
      } catch { /* file not present */ }
    }
    return blocks.join('\n\n');
  }

  /** Combine custom instructions, the chosen output style, and repo rule files into the system prompt's project block. */
  private async composeRules(config: vscode.WorkspaceConfiguration): Promise<string> {
    const custom = config.get<string>('customInstructions', '').trim();
    const style = OUTPUT_STYLE_TEXT[this.outputStyle()];
    const rules = await this.readProjectRules();
    return [
      custom ? `## Your custom instructions\n${custom}` : '',
      style ? `## Output style\n${style}` : '',
      rules
    ].filter(Boolean).join('\n\n');
  }

  /** The user's chosen response style, persisted globally. Defaults to 'default'. */
  private outputStyle(): OutputStyle {
    const value = this.context.globalState.get<string>('techwordCode.outputStyle', 'default');
    return (value in OUTPUT_STYLE_TEXT ? value : 'default') as OutputStyle;
  }

  /** Let the user pick how Techword writes its replies. Applied to the current and future tasks. */
  private async chooseOutputStyle(): Promise<void> {
    const current = this.outputStyle();
    const pick = await vscode.window.showQuickPick(
      OUTPUT_STYLE_OPTIONS.map((o) => ({ label: (o.id === current ? '$(check) ' : '') + o.label, description: o.description, id: o.id })),
      { title: 'Output style', placeHolder: 'How should Techword Code write its replies?' }
    );
    if (!pick) { return; }
    await this.context.globalState.update('techwordCode.outputStyle', pick.id);
    // Re-apply immediately so the running/next turn uses it.
    if (this.session) { this.session.setProjectRules(await this.composeRules(vscode.workspace.getConfiguration('techwordCode'))); }
    void vscode.window.showInformationMessage(`Output style set to "${OUTPUT_STYLE_OPTIONS.find((o) => o.id === pick.id)?.label ?? pick.id}".`);
  }

  /** Rename the current chat. The title stops being auto-derived from the first message. */
  private async renameConversation(): Promise<void> {
    const messages = this.session?.getMessages() ?? [];
    const suggested = this.customTitle ?? (messages.length ? ConversationStore.titleFrom(messages) : 'New chat');
    const value = await vscode.window.showInputBox({ title: 'Rename chat', prompt: 'New name for this conversation', value: suggested, validateInput: (v) => v.trim().length > 80 ? 'Keep it under 80 characters.' : undefined });
    if (value === undefined) { return; }
    const clean = value.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean) { return; }
    this.customTitle = clean;
    await this.saveCurrent();               // persists if there are messages
    await this.store.rename(this.conversationId, clean); // fallback for an unsaved (empty) chat
    this.post({ kind: 'renamed', title: clean });
    this.post({ kind: 'history', items: this.store.list(), currentId: this.conversationId });
  }

  /** Duplicate the current chat into a new one, so the user can branch off without losing this thread. */
  private async forkConversation(): Promise<void> {
    const session = this.session;
    const messages = session?.getMessages() ?? [];
    if (!session || !messages.some((m) => m.role === 'user')) {
      void vscode.window.showInformationMessage('Nothing to fork yet — start a chat first.');
      return;
    }
    await this.saveCurrent(); // make sure the original is stored before we branch
    const base = this.customTitle ?? ConversationStore.titleFrom(messages);
    const forkTitle = `Fork of ${base}`.slice(0, 80);
    const newId = crypto.randomUUID();
    await this.store.save({
      id: newId,
      title: forkTitle,
      titleCustom: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspace: vscode.workspace.workspaceFolders?.[0]?.name,
      messages: this.sanitizeForStorage(messages),
      totalTokens: session.tokens
    });
    // Switch the live session onto the fork; the messages are identical so no reload needed.
    this.conversationId = newId;
    this.conversationCreatedAt = Date.now();
    this.customTitle = forkTitle;
    this.post({ kind: 'renamed', title: forkTitle });
    this.post({ kind: 'history', items: this.store.list(), currentId: this.conversationId });
    void vscode.window.showInformationMessage(`Forked into "${forkTitle}". The original stays in History.`);
  }

  /** Back the session's remember/forget tools with the on-disk store, and refresh the live prompt after each change. */
  private memorySink(): MemorySink {
    return {
      remember: async (text, scope) => {
        const result = await this.memory.remember(text, scope);
        await this.refreshMemory();
        if (result.saved) { return `Saved to ${result.entry?.scope ?? 'memory'}: "${result.entry?.text}"`; }
        if (result.reason === 'duplicate') { return 'Already remembered — nothing to add.'; }
        return 'Nothing to remember (empty after cleanup).';
      },
      forget: async (query) => {
        const removed = await this.memory.forget(query);
        await this.refreshMemory();
        return removed > 0 ? `Forgot ${removed} ${removed === 1 ? 'memory' : 'memories'}.` : 'No matching memory to forget.';
      }
    };
  }

  /** Re-inject the current memory into the running session so a remember/forget takes effect immediately. */
  private async refreshMemory(): Promise<void> {
    if (this.session) { this.session.setMemory(await this.memory.compose()); }
  }

  /** View, edit, add, or delete saved memories — the client stays in control of what Techword remembers. */
  private async manageMemory(): Promise<void> {
    const entries = await this.memory.list();
    type Item = vscode.QuickPickItem & { id?: string; action?: 'add' | 'clear' };
    const items: Item[] = [
      { label: '$(add) Remember something new…', action: 'add' },
      ...(entries.length ? [{ label: '$(trash) Forget all…', action: 'clear' as const }] : []),
      ...(entries.length ? [{ label: '', kind: vscode.QuickPickItemKind.Separator } as Item] : []),
      ...entries.map((entry) => ({ label: entry.text, description: entry.scope === 'project' ? 'project · this repo' : 'global · all projects', id: entry.id }))
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `Memory (${entries.length})`,
      placeHolder: entries.length ? 'Select a memory to edit or delete, or add a new one' : 'Nothing remembered yet — add the first memory'
    });
    if (!pick) { return; }
    if (pick.action === 'add') { await this.addMemoryInteractive(); return; }
    if (pick.action === 'clear') {
      const confirm = await vscode.window.showWarningMessage('Forget all saved memories?', { modal: true, detail: 'This deletes every project and global memory Techword Code has saved. It cannot be undone.' }, 'Forget all');
      if (confirm === 'Forget all') { await this.memory.clear(); await this.refreshMemory(); void vscode.window.showInformationMessage('All memories cleared.'); }
      return;
    }
    if (pick.id) { await this.editMemoryInteractive(pick.id, pick.label); }
  }

  private async addMemoryInteractive(): Promise<void> {
    const text = await vscode.window.showInputBox({ title: 'Remember something', prompt: 'A durable fact for Techword to keep across sessions', placeHolder: 'e.g. This project uses pnpm, not npm.' });
    if (!text || !text.trim()) { return; }
    const scope = await this.pickScope();
    if (!scope) { return; }
    const result = await this.memory.remember(text, scope);
    await this.refreshMemory();
    void vscode.window.showInformationMessage(result.saved ? 'Saved to memory.' : result.reason === 'duplicate' ? 'Already remembered.' : 'Nothing saved.');
  }

  private async editMemoryInteractive(id: string, current: string): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [{ label: '$(edit) Edit', act: 'edit' as const }, { label: '$(trash) Delete', act: 'delete' as const }],
      { title: 'Memory', placeHolder: current }
    );
    if (!choice) { return; }
    if (choice.act === 'delete') { await this.memory.deleteById(id); await this.refreshMemory(); void vscode.window.showInformationMessage('Memory deleted.'); return; }
    const text = await vscode.window.showInputBox({ title: 'Edit memory', value: current });
    if (text === undefined || !text.trim()) { return; }
    await this.memory.editById(id, text);
    await this.refreshMemory();
    void vscode.window.showInformationMessage('Memory updated.');
  }

  private async pickScope(): Promise<'project' | 'global' | undefined> {
    const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.[0]);
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'This project', description: 'Saved in .techword/memory.json — travels with the repo', scope: 'project' as const },
        { label: 'All my projects', description: 'Global — follows you everywhere', scope: 'global' as const }
      ],
      { title: 'Where should this be remembered?', placeHolder: hasWorkspace ? 'Pick a scope' : 'No workspace open — global recommended' }
    );
    return pick?.scope;
  }

  /** List every workspace file this conversation has touched (read or edited) and open the one the user picks. */
  private async showConversationFiles(): Promise<void> {
    const messages = this.session?.getMessages() ?? [];
    const paths = filesTouched(messages);
    if (paths.length === 0) {
      void vscode.window.showInformationMessage('No files touched in this chat yet.');
      return;
    }
    const pick = await vscode.window.showQuickPick(paths, { title: `Files in this chat (${paths.length})`, placeHolder: 'Open a file Techword read or edited' });
    if (pick) { await this.openFile(pick); }
  }

  private async startTask(prompt: string): Promise<void> {
    const session = await this.ensureSession();
    if (!session) { this.post({ kind: 'error', message: 'Connect a valid Techword API key in Settings (⚙) to start.' }); return; }
    const attachments = this.pendingAttachments;
    this.pendingAttachments = [];
    this.post({ kind: 'attachments', items: [] });
    // No pre-run postState: the controller isn't set yet, so it would report running:false and (with
    // the webview's authoritative setBusy) clear the bar the instant a task starts. run() emits its
    // own 'Working…' status; the post-run postState below reports the settled state.
    await session.run(prompt, attachments);
    await this.saveCurrent();
    await this.postState();
  }

  private async retry(): Promise<void> {
    const session = await this.ensureSession();
    if (!session) { this.post({ kind: 'error', message: 'Connect a valid Techword API key in Settings (⚙) to start.' }); return; }
    // No pre-run postState here either — same reason as startTask: it would report running:false and
    // clear the bar just as the retry begins. retry()'s loop emits 'Working…' immediately.
    await session.retry();
    await this.saveCurrent();
    await this.postState();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') { return; }
    const input = message as { kind?: unknown; [key: string]: unknown };
    switch (input.kind) {
      case 'submit':
        if (typeof input.prompt === 'string' && input.prompt.trim()) {
          const text = input.prompt.trim();
          if (this.session?.awaitingAnswer) { this.session.answer(text); }
          else if (this.session?.running) { this.session.enqueue(text); }
          else { await this.startTask(text); }
        }
        break;
      case 'retry': await this.retry(); break;
      case 'setThinking':
        // The Brain toggle: reasoning is off by default (for speed); turning it on makes the model stream
        // its thinking so the panel isn't empty. Remembered for the session and applied on the next turn.
        if (typeof input.on === 'boolean') { this.thinkingOn = input.on; this.session?.setThinking(input.on); }
        break;
      case 'openFile': if (typeof input.path === 'string') { await this.openFile(input.path, typeof input.line === 'number' ? input.line : undefined); } break;
      case 'openTerminal': await this.openTerminal(); break;
      case 'layout': if (typeof input.action === 'string') { await this.layout(input.action); } break;
      case 'showChanges': await this.showChanges(); break;
      case 'preview': await this.preview(); break;
      case 'copy': if (typeof input.text === 'string' && input.text) { await vscode.env.clipboard.writeText(input.text); } break;
      case 'runCommand':
        if (typeof input.command === 'string' && input.command && typeof input.token === 'string') { await this.runChatCommand(input.command, input.token); }
        break;
      case 'revert':
        if (typeof input.id === 'string' && this.session) {
          try { await this.session.restoreCheckpoint(input.id); } catch (error) { this.post({ kind: 'error', message: error instanceof Error ? error.message : String(error) }); }
          await this.saveCurrent();
        }
        break;
      case 'approvalResponse':
        if (typeof input.id === 'string') {
          const resolve = this.pendingApprovals.get(input.id);
          if (resolve) { this.pendingApprovals.delete(input.id); resolve(input.approved === true); this.post({ kind: 'approvalResolved', id: input.id, approved: input.approved === true }); }
        }
        break;
      case 'editQueued':
        if (typeof input.id === 'string' && typeof input.text === 'string' && input.text.trim() && this.session) { this.session.editQueued(input.id, input.text.trim()); }
        break;
      case 'cancelQueued':
        if (typeof input.id === 'string' && this.session) { this.session.removeQueued(input.id); }
        break;
      case 'touchQueued': // user opened the chip to edit — hold it so the agent doesn't grab it mid-edit
        if (typeof input.id === 'string' && this.session) { this.session.touchQueued(input.id); }
        break;
      case 'stop': this.stop(); break;
      case 'newTask': await this.newTask(); break;
      case 'attach': await this.attach(); break;
      case 'removeAttachment':
        if (typeof input.id === 'string') { this.pendingAttachments = this.pendingAttachments.filter((item) => item.id !== input.id); this.postAttachments(); }
        break;
      case 'history': this.post({ kind: 'history', items: this.store.list(), currentId: this.conversationId }); break;
      case 'renameConversation': await this.renameConversation(); break;
      case 'forkConversation': await this.forkConversation(); break;
      case 'conversationFiles': await this.showConversationFiles(); break;
      case 'chooseOutputStyle': await this.chooseOutputStyle(); break;
      case 'memory': await this.manageMemory(); break;
      case 'loadConversation': if (typeof input.id === 'string') { await this.loadConversation(input.id); } break;
      case 'deleteConversation':
        if (typeof input.id === 'string') { await this.store.delete(input.id); this.post({ kind: 'history', items: this.store.list(), currentId: this.conversationId }); }
        break;
      case 'saveApiKey':
        if (typeof input.apiKey === 'string' && input.apiKey.trim()) { await this.saveApiKey(input.apiKey.trim()); }
        break;
      case 'disconnect':
        await this.providers.removeApiKey();
        if (this.session) { this.session.setApiKey(''); }
        this.post({ kind: 'connection', ok: false, message: 'API key removed. Enter a key to reconnect.' });
        await this.postState();
        break;
      case 'selectModel':
        if (typeof input.model === 'string') { await this.providers.selectModel(input.model); if (this.session) { const p = this.providers.active(); if (p) { this.session.setProvider(p); } } await this.postState(); }
        break;
      case 'setAutoApprove':
        this.autoApprove = { edits: input.edits === true, commands: input.commands === true };
        await this.context.workspaceState.update('techwordCode.autoApprove', this.autoApprove);
        await this.postState();
        break;
      case 'setMode':
        this.mode = input.mode === 'plan' ? 'plan' : 'act';
        this.session?.setMode(this.mode);
        await this.postState();
        break;
      case 'setAgentMode': {
        // One picker sets both the plan/act mode and the auto-approve policy (like Claude Code's modes).
        const m = input.mode;
        // Bypass is dangerous — confirm before turning it on (skip if already in it).
        if (m === 'bypass' && this.currentAgentMode() !== 'bypass') {
          const choice = await vscode.window.showWarningMessage(
            'Turn on Bypass permissions?',
            { modal: true, detail: 'Techword Code will apply ALL file edits and run terminal commands WITHOUT asking, so it can work unattended (e.g. overnight). A small set of genuinely catastrophic commands (rm -rf, disk format, fork bomb, piping a download into a shell, force push) still asks once as a safety net. Use this only in a project you trust.' },
            'Turn on Bypass'
          );
          if (choice !== 'Turn on Bypass') { await this.postState(); break; } // revert the picker
        }
        if (m === 'plan') {
          this.mode = 'plan'; // read-only; auto-approve is left as-is so it's restored when you leave Plan
        } else {
          this.mode = 'act';
          if (m === 'edit') { this.autoApprove = { edits: true, commands: false }; }
          else if (m === 'bypass') { this.autoApprove = { edits: true, commands: true }; }
          else { this.autoApprove = { edits: false, commands: false }; } // manual
          await this.context.workspaceState.update('techwordCode.autoApprove', this.autoApprove);
        }
        this.session?.setMode(this.mode);
        await this.postState();
        break;
      }
      case 'testConnection': await this.testConnection(); break;
      case 'getState': await this.postState(); break;
    }
  }

  private async newTask(): Promise<void> {
    await this.saveCurrent();
    try { this.session?.reset(); } catch (error) { this.post({ kind: 'error', message: error instanceof Error ? error.message : String(error) }); return; }
    this.conversationId = crypto.randomUUID();
    this.conversationCreatedAt = Date.now();
    this.customTitle = undefined;
    this.pendingAttachments = [];
    this.post({ kind: 'attachments', items: [] });
  }

  private async attach(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach to Techword Code' });
    if (!uris || uris.length === 0) { return; }
    for (const uri of uris.slice(0, 10)) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const name = uri.path.split('/').pop() ?? 'file';
        const ext = name.split('.').pop()?.toLowerCase() ?? '';
        if (IMAGE_EXT.has(ext)) {
          const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
          this.pendingAttachments.push({ id: crypto.randomUUID(), name, kind: 'image', mime, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` });
        } else {
          this.pendingAttachments.push({ id: crypto.randomUUID(), name, kind: 'text', text: Buffer.from(bytes).toString('utf8').slice(0, 100000) });
        }
      } catch { /* skip unreadable file */ }
    }
    this.postAttachments();
  }

  private postAttachments(): void {
    this.post({ kind: 'attachments', items: this.pendingAttachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind, dataUrl: a.kind === 'image' ? a.dataUrl : undefined })) });
  }

  /** Debounced incremental save. Persists mid-turn (after each tool round) so a long autonomous run that
   *  is interrupted — window closed, extension host reload, crash — keeps its progress instead of snapping
   *  back to the last *completed* turn. Without this, an interrupted turn is lost and History drifts backward. */
  private scheduleSave(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); }
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.saveCurrent(); }, 800);
  }

  private async saveCurrent(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    const session = this.session;
    if (!session) { return; }
    const messages = session.getMessages();
    if (!messages.some((message) => message.role === 'user')) { return; }
    // Snapshot the state synchronously (before any await), then serialize the write onto a chain so a
    // debounced mid-turn save and an end-of-turn save can't interleave on the shared conversation index.
    const record: StoredConversation = {
      id: this.conversationId,
      title: this.customTitle ?? ConversationStore.titleFrom(messages),
      titleCustom: this.customTitle !== undefined,
      createdAt: this.conversationCreatedAt,
      updatedAt: Date.now(),
      workspace: vscode.workspace.workspaceFolders?.[0]?.name,
      messages: this.sanitizeForStorage(messages),
      totalTokens: session.tokens
    };
    this.saving = this.saving.then(() => this.store.save(record)).catch(() => undefined);
    await this.saving;
  }

  /** Drop bulky image data from persisted history to keep globalState small. */
  private sanitizeForStorage(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => {
      if (Array.isArray(message.content)) {
        const parts: ContentPart[] = message.content.map((part) => part.type === 'image_url' ? { type: 'text', text: '[image attachment]' } : part);
        return { ...message, content: parts };
      }
      return message;
    });
  }

  private async loadConversation(id: string): Promise<void> {
    const stored = this.store.get(id);
    if (!stored) { return; }
    await this.saveCurrent();
    const session = await this.ensureSession();
    if (!session) { return; }
    try { session.loadMessages(stored.messages, stored.totalTokens); } catch (error) { this.post({ kind: 'error', message: error instanceof Error ? error.message : String(error) }); return; }
    this.conversationId = stored.id;
    this.conversationCreatedAt = stored.createdAt;
    this.customTitle = stored.titleCustom ? stored.title : undefined;
    this.pendingAttachments = [];
    this.post({ kind: 'load', title: stored.title, items: this.displayFrom(stored.messages) });
    { const c = this.costConfig(); this.post({ kind: 'usage', total: stored.totalTokens, usdPerMillion: c.usdPerMillion, showCost: c.showCost }); }
    void session.refreshBilling(); // show real spend for this key on open, before the first turn
    await this.postState();
  }

  private displayFrom(messages: ChatMessage[]): DisplayItem[] {
    const items: DisplayItem[] = [];
    for (const message of messages) {
      if (message.role === 'user') { items.push({ role: 'user', text: ConversationStore.plainText(message.content) }); }
      else if (message.role === 'assistant') {
        const text = ConversationStore.plainText(message.content).trim();
        if (text) { items.push({ role: 'assistant', text }); }
      }
    }
    return items;
  }

  private async saveApiKey(apiKey: string): Promise<void> {
    await this.providers.saveApiKey(apiKey);
    if (this.session) { this.session.setApiKey(apiKey); }
    await this.testConnection();
  }

  private async testConnection(): Promise<void> {
    const provider = this.providers.active();
    const key = await this.providers.getApiKey();
    if (!provider || !key) { this.post({ kind: 'connection', ok: false, message: 'Enter your Techword API key first.' }); return; }
    try {
      // Time a real round-trip to the API (list models = the lightest authenticated call). The latency
      // is the true extension→proxy→upstream time, so a green light here means the whole path is alive.
      const started = Date.now();
      const models = await new OpenAICompatibleClient(provider, key).listModels(AbortSignal.timeout(15000));
      const latencyMs = Date.now() - started;
      await this.providers.resolveModels();
      const names = models.map((model) => model.displayName ?? labelForModel(model.id)).filter(Boolean).slice(0, 12);
      this.post({ kind: 'connection', ok: true, message: 'Techword API is alive.', latencyMs, models: names });
    } catch (error) {
      this.post({ kind: 'connection', ok: false, message: error instanceof Error ? error.message : 'Could not reach Techword API.' });
    }
    await this.postState();
  }

  private async postState(): Promise<void> {
    const provider = this.providers.active();
    const key = await this.providers.getApiKey();
    const hasKey = Boolean(key);
    const keyHint = key && key.length >= 4 ? `••••${key.slice(-4)}` : undefined;
    const models = this.providers.availableModels().map((model) => ({ id: model.id, label: model.displayName ?? labelForModel(model.id) }));
    this.post({ kind: 'state', connected: Boolean(provider) && hasKey, hasKey, keyHint, models, selectedModel: provider?.selectedModel, running: this.session?.running ?? false, mode: this.mode, autoApprove: this.autoApprove, agentMode: this.currentAgentMode(), mcp: this.mcp.statusList() });
  }

  /** Collapse (plan/act + auto-approve) into the single mode the composer picker shows. */
  private currentAgentMode(): 'manual' | 'edit' | 'plan' | 'bypass' {
    if (this.mode === 'plan') { return 'plan'; }
    if (this.autoApprove.edits && this.autoApprove.commands) { return 'bypass'; }
    if (this.autoApprove.edits) { return 'edit'; }
    return 'manual';
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomUUID();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="${styleUri}" rel="stylesheet">
<title>Techword Code</title></head>
<body>
<header id="topbar">
  <div class="brand"><span class="dot" id="statusDot"></span><span>Techword Code</span><span id="keyTotal" class="key-total hidden" title="Total spent on this API key"></span></div>
  <div class="actions">
    <button id="expandBtn" class="icon winctl" title="Expand / restore width" aria-label="Expand or restore width">⛶</button>
    <button id="minimizeBtn" class="icon winctl" title="Minimize (hide panel)" aria-label="Minimize (hide panel)">▁</button>
    <select id="modelSelect" title="Model" aria-label="Model"></select>
    <button id="historyBtn" class="icon" title="Chat history" aria-label="Chat history">History</button>
    <button id="newTaskBtn" class="icon" title="New chat" aria-label="New chat">New</button>
    <div class="more-menu">
      <button id="moreBtn" class="icon" title="More options" aria-haspopup="true" aria-expanded="false">⋯</button>
      <div id="moreDropdown" class="more-dropdown hidden" role="menu">
        <button class="more-opt" data-act="rename" role="menuitem"><span class="mi">✎</span> Rename chat</button>
        <button class="more-opt" data-act="fork" role="menuitem"><span class="mi">⑂</span> Fork chat</button>
        <button class="more-opt" data-act="files" role="menuitem"><span class="mi">🗂</span> Files in this chat</button>
        <button class="more-opt" data-act="memory" role="menuitem"><span class="mi">🧠</span> Memory…</button>
        <button class="more-opt" data-act="outputStyle" role="menuitem"><span class="mi">✦</span> Output style…</button>
        <div class="more-sep"></div>
        <button class="more-opt" data-act="history" role="menuitem"><span class="mi">🕘</span> Chat history</button>
        <button class="more-opt" data-act="settings" role="menuitem"><span class="mi">⚙</span> Settings</button>
      </div>
    </div>
    <button id="settingsBtn" class="icon" title="Settings">⚙</button>
  </div>
</header>

<section id="settings" class="panel hidden" aria-label="Settings">
  <h2>Settings</h2>
  <label for="apiKey">Techword API key</label>
  <div class="row">
    <input id="apiKey" type="password" placeholder="Enter your Techword API key" autocomplete="off" spellcheck="false">
    <button id="saveKeyBtn">Save &amp; connect</button>
  </div>
  <div class="row keyrow">
    <span id="keyStatus" class="hint"></span>
    <button id="disconnectBtn" class="secondary hidden">Disconnect</button>
  </div>
  <p class="hint">Stored in VS Code SecretStorage only. Never written to settings or files.</p>
  <label for="settingsModel">Model</label>
  <select id="settingsModel" aria-label="Model"></select>
  <button id="testBtn" class="secondary">Test connection</button>
  <div id="connLine" class="conn-line" role="status" aria-live="polite">
    <span id="connDot" class="conn-dot"></span>
    <span id="connMsg" class="hint"></span>
    <span id="connLatency" class="conn-latency"></span>
  </div>
  <div id="connModels" class="conn-models hidden"></div>

  <label>Auto-approve (this project only)</label>
  <label class="check"><input type="checkbox" id="autoEdits"> Apply file edits without asking</label>
  <label class="check"><input type="checkbox" id="autoCommands"> Run terminal commands without asking</label>
  <p class="hint">Off by default. Only turn on for projects you trust — actions still appear in the chat, but run without a click. The workspace must be trusted.</p>

  <label>Capabilities</label>
  <ul class="caps">
    <li>🗺️ Code map — instant high-level map of large repos</li>
    <li>🕵️ Parallel exploration — several read-only scouts at once</li>
    <li>🔌 MCP tools — connect external tool servers</li>
    <li>🛡️ Safe autonomy — risky commands always ask first</li>
    <li>♻️ Checkpoints — revert any edit from the chat</li>
  </ul>
  <label>MCP servers</label>
  <div id="mcpStatus" class="mcp-status"></div>
  <p class="hint">Add servers under <code>techwordCode.mcpServers</code> in Settings (JSON). Their tools appear to the agent automatically in Act mode.</p>
</section>

<section id="historyPanel" class="panel hidden" aria-label="Chat history">
  <h2>Chat history</h2>
  <div id="historyList"></div>
  <p class="hint">Chats are saved automatically. Open one to continue where you left off.</p>
</section>

<main id="log" aria-live="polite"></main>

<div id="workbar" class="workbar hidden" aria-live="polite">
  <span class="workbar-spin"></span>
  <span id="workbarText" class="workbar-text">Working…</span>
  <button id="transcriptBtn" class="workbar-toggle" title="Show what Techword is thinking">Brain ⋯</button>
</div>
<section id="transcript" class="transcript hidden" aria-label="Brain — the model's reasoning">
  <button id="transcriptClose" class="transcript-close" title="Hide Brain" aria-label="Hide Brain">✕</button>
  <div id="transcriptList" class="transcript-list"></div>
</section>

<div id="queued" class="queued-tray"></div>
<div id="attachments" class="attachments"></div>
<div id="composer">
  <textarea id="prompt" rows="3" placeholder="Describe what to build, fix, test, or run… Attach files/images with 📎, reference files with @path. Ctrl/Cmd+Enter to send."></textarea>
  <div class="composer-actions">
    <div class="mode-picker">
      <button id="modeBtn" class="mode-btn" title="Choose how Techword acts" aria-haspopup="true" aria-expanded="false">
        <span class="mode-tick" id="modeDot"></span><span id="modeBtnLabel">Manual</span><span class="caret">▴</span>
      </button>
      <div id="modeMenu" class="mode-menu hidden" role="menu">
        <button class="mode-opt" data-mode="manual" role="menuitem">
          <span class="mo-name">Manual</span>
          <span class="mo-desc">Asks before every file edit and command. You approve each step.</span>
        </button>
        <button class="mode-opt" data-mode="edit" role="menuitem">
          <span class="mo-name">Edit</span>
          <span class="mo-desc">Applies file edits automatically. Still asks before running commands.</span>
        </button>
        <button class="mode-opt" data-mode="plan" role="menuitem">
          <span class="mo-name">Plan</span>
          <span class="mo-desc">Read-only. Explores and proposes a plan without changing anything.</span>
        </button>
        <button class="mode-opt" data-mode="bypass" role="menuitem">
          <span class="mo-name">Bypass permissions</span>
          <span class="mo-desc">Runs everything without asking — even destructive commands. For trusted projects and unattended runs.</span>
        </button>
      </div>
    </div>
    <button id="terminalBtn" class="icon icon-svg" title="Open a terminal" aria-label="Open a terminal">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.6"></rect>
        <path d="M4.3 6.1 6.4 8l-2.1 1.9"></path>
        <path d="M8.4 10.1h3.3"></path>
      </svg>
    </button>
    <button id="changesBtn" class="icon icon-svg" title="View changes (diff)" aria-label="View changes (diff)">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 2.6v4.1"></path>
        <path d="M5.95 4.65h4.1"></path>
        <path d="M5.95 11.4h4.1"></path>
      </svg>
    </button>
    <button id="previewBtn" class="icon icon-svg" title="Preview the current file" aria-label="Preview the current file">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M1.5 8s2.4-4.4 6.5-4.4S14.5 8 14.5 8s-2.4 4.4-6.5 4.4S1.5 8 1.5 8Z"></path>
        <circle cx="8" cy="8" r="1.9"></circle>
      </svg>
    </button>
    <button id="attachBtn" class="icon icon-svg" title="Attach files or images" aria-label="Attach files or images">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12.7 7.3 7.5 12.5a2.6 2.6 0 0 1-3.7-3.7l5.6-5.6a1.75 1.75 0 0 1 2.5 2.5L6.1 11.5"></path>
      </svg>
    </button>
    <button id="sendBtn" aria-label="Send message">Send</button>
    <button id="stopBtn" class="secondary hidden" aria-label="Stop the agent">Stop</button>
    <span id="usage" class="usage"></span>
    <span id="ctxRing" class="ctx-ring hidden" title="Context used">
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <circle class="ctx-track" cx="9" cy="9" r="7"></circle>
        <circle id="ctxArc" class="ctx-arc" cx="9" cy="9" r="7"></circle>
      </svg>
    </span>
  </div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  }
}
