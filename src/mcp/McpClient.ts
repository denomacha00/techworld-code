import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServerConfig } from '../types';

// A minimal Model Context Protocol client speaking JSON-RPC 2.0 over a child process's stdio,
// with newline-delimited JSON framing. Dependency-free so it bundles with esbuild like the rest
// of the extension. Supports the handful of methods Techword Code needs: initialize, tools/list,
// tools/call. Each server runs as its own process; McpHub owns the set of them.

interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string }; }
interface McpToolDef { name: string; description?: string; inputSchema?: Record<string, unknown>; }

const REQUEST_TIMEOUT_MS = 30000;
const INIT_TIMEOUT_MS = 20000;

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stderr = '';
  private started = false;

  constructor(public readonly name: string, private readonly config: McpServerConfig) {}

  get isRunning(): boolean { return this.started && this.proc !== undefined && this.proc.exitCode === null; }

  /** Launch the server process and perform the MCP initialize handshake. */
  async start(): Promise<void> {
    if (this.started) { return; }
    this.started = true;
    const command = this.config.command;
    // On Windows, bare command names like `npx`/`npm`/`python` resolve to .cmd/.bat shims that can
    // only be launched through the shell. A real executable path (…\node.exe, or any path) is spawned
    // directly — using the shell there would mangle paths that contain spaces. When we do use the
    // shell, quote any args containing spaces so the shell doesn't split them.
    const isDirectExe = /\.exe$/i.test(command) || (/[\\/]/.test(command) && !/\.(cmd|bat)$/i.test(command));
    const useShell = process.platform === 'win32' && !isDirectExe;
    const rawArgs = this.config.args ?? [];
    const args = useShell ? rawArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : rawArgs;
    const child = spawn(command, args, {
      cwd: this.config.cwd || undefined,
      env: { ...process.env, ...(this.config.env ?? {}) },
      shell: useShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams;
    this.proc = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.on('error', (error) => this.failAll(new Error(`MCP server "${this.name}" could not start: ${error.message}`)));
    child.on('exit', (code) => this.failAll(new Error(`MCP server "${this.name}" exited (code ${code ?? 'null'}).${this.stderr ? ` ${this.stderr.trim().split('\n').pop()}` : ''}`)));

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'Techword Code', version: '1.2.0' }
    }, INIT_TIMEOUT_MS);
    this.notify('notifications/initialized', {});
  }

  /** Discover the tools this server exposes. */
  async listTools(): Promise<McpToolDef[]> {
    const result = await this.request('tools/list', {}) as { tools?: McpToolDef[] } | undefined;
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /** Invoke a tool on this server and return its output as text. */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name: toolName, arguments: args }) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts.map((part) => (part.type === 'text' ? part.text ?? '' : `[${part.type ?? 'content'}]`)).join('\n').trim();
    const prefix = result?.isError ? 'The MCP tool reported an error:\n' : '';
    return `${prefix}${text || '(the tool returned no textual content)'}`;
  }

  /** Terminate the server process. */
  stop(): void {
    this.failAll(new Error('MCP server stopped.'));
    try { this.proc?.kill(); } catch { /* already gone */ }
    this.proc = undefined;
    this.started = false;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) { this.handleLine(line); }
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try { message = JSON.parse(line) as JsonRpcResponse; } catch { return; /* ignore non-JSON log lines */ }
    if (typeof message.id !== 'number') { return; } // notification or request from server — not handled
    const entry = this.pending.get(message.id);
    if (!entry) { return; }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) { entry.reject(new Error(message.error.message || `MCP error ${message.error.code}`)); }
    else { entry.resolve(message.result); }
  }

  private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) { return Promise.reject(new Error(`MCP server "${this.name}" is not running.`)); }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP server "${this.name}" timed out on ${method}.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { proc.stdin.write(payload); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private notify(method: string, params: unknown): void {
    try { this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* best effort */ }
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
}
