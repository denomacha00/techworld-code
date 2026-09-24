import { McpClient } from './McpClient';
import type { McpServerConfig, McpToolInfo } from '../types';

// Owns the set of configured MCP servers, starts/stops them to match config, discovers their tools,
// and routes tool calls. Tools are exposed to the model as mcp__<server>__<tool> so they never
// collide with Techword Code's built-in tools and the model can tell where a tool comes from.

const QUALIFIED_PREFIX = 'mcp__';

export interface McpStatus { server: string; running: boolean; toolCount: number; error?: string; }

export class McpHub {
  private readonly clients = new Map<string, McpClient>();
  private readonly tools = new Map<string, McpToolInfo>(); // by qualifiedName
  private readonly statuses = new Map<string, McpStatus>();
  private readonly configs = new Map<string, McpServerConfig>(); // last-synced config per wanted server, for reconnect
  private readonly reconnecting = new Map<string, Promise<void>>(); // in-flight reconnect guard (one at a time per server)
  private readonly reconnectAfter = new Map<string, number>(); // epoch-ms cooldown so a truly-dead server isn't retried on every call
  private lastConfigJson = '';
  private static readonly RECONNECT_COOLDOWN_MS = 15000;

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  /** True if a tool name refers to an MCP tool. */
  static isMcpTool(name: string): boolean { return name.startsWith(QUALIFIED_PREFIX); }

  /** Start/stop servers so the running set matches the given config. Safe to call repeatedly. */
  async sync(config: Record<string, McpServerConfig>): Promise<void> {
    const configJson = JSON.stringify(config);
    if (configJson === this.lastConfigJson) { return; } // unchanged
    this.lastConfigJson = configJson;

    const wanted = new Map(Object.entries(config).filter(([, server]) => server && !server.disabled && typeof server.command === 'string' && server.command.trim()));

    // Stop servers that were removed or disabled.
    for (const [name, client] of [...this.clients]) {
      if (!wanted.has(name)) {
        client.stop();
        this.clients.delete(name);
        this.statuses.delete(name);
        this.configs.delete(name);
        this.reconnecting.delete(name);
        this.reconnectAfter.delete(name);
        this.removeToolsFor(name);
      }
    }

    // Start servers that are newly configured (leave already-running ones alone).
    await Promise.all([...wanted].map(async ([name, server]) => {
      this.configs.set(name, server); // remember config so a later crash can be reconnected
      if (this.clients.has(name)) { return; }
      await this.connectServer(name, server);
    }));
  }

  /** Launch (or relaunch) one server and register its tools. Replaces any prior client for the name —
   *  used both by sync (fresh start) and by the reconnect path (after a runtime crash). On failure it
   *  records the error in the status list and leaves no client behind. */
  private async connectServer(name: string, server: McpServerConfig): Promise<void> {
    const previous = this.clients.get(name);
    if (previous) { previous.stop(); }
    const client = new McpClient(name, server);
    this.clients.set(name, client);
    try {
      await client.start();
      const defs = await client.listTools();
      this.removeToolsFor(name); // clear any stale tools from a prior incarnation before re-registering
      for (const def of defs) {
        const qualifiedName = `${QUALIFIED_PREFIX}${sanitize(name)}__${sanitize(def.name)}`;
        this.tools.set(qualifiedName, {
          server: name,
          toolName: def.name,
          qualifiedName,
          description: (def.description ?? `Tool "${def.name}" from MCP server "${name}".`).slice(0, 1024),
          inputSchema: def.inputSchema && typeof def.inputSchema === 'object' ? def.inputSchema : { type: 'object', properties: {} }
        });
      }
      this.statuses.set(name, { server: name, running: true, toolCount: defs.length });
      this.reconnectAfter.delete(name); // healthy again — clear any cooldown so a future crash retries at once
      this.log(`MCP server "${name}" connected with ${defs.length} tool(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      client.stop();
      this.clients.delete(name);
      this.statuses.set(name, { server: name, running: false, toolCount: 0, error: message });
      this.log(`MCP server "${name}" failed: ${message}`);
    }
  }

  /** Bring a server back if it crashed at runtime. One reconnect in flight at a time; after a failed
   *  attempt a short cooldown keeps a genuinely dead server from stalling every subsequent tool call. */
  private async ensureRunning(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client && client.isRunning) { return; }
    const inflight = this.reconnecting.get(name);
    if (inflight) { return inflight; }
    const server = this.configs.get(name);
    if (!server) { return; } // not a wanted server — nothing to reconnect to
    if (Date.now() < (this.reconnectAfter.get(name) ?? 0)) { return; } // in cooldown after a recent failure — fail fast
    this.reconnectAfter.set(name, Date.now() + McpHub.RECONNECT_COOLDOWN_MS);
    const attempt = this.connectServer(name, server).finally(() => { this.reconnecting.delete(name); });
    this.reconnecting.set(name, attempt);
    return attempt;
  }

  /** Tool definitions in Anthropic format, ready to append to the model's tool list. */
  toolDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return [...this.tools.values()].map((tool) => ({ name: tool.qualifiedName, description: tool.description, input_schema: tool.inputSchema }));
  }

  getTool(qualifiedName: string): McpToolInfo | undefined { return this.tools.get(qualifiedName); }
  hasTools(): boolean { return this.tools.size > 0; }
  statusList(): McpStatus[] { return [...this.statuses.values()]; }

  /** Call an MCP tool by its qualified (mcp__server__tool) name. */
  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(qualifiedName);
    if (!tool) { return `Tool error: ${qualifiedName} is not a known MCP tool.`; }
    let client = this.clients.get(tool.server);
    if (!client || !client.isRunning) {
      await this.ensureRunning(tool.server); // a server that crashed mid-session gets one bounded reconnect
      client = this.clients.get(tool.server);
    }
    if (!client || !client.isRunning) {
      const err = this.statuses.get(tool.server)?.error;
      return `Tool error: MCP server "${tool.server}" is not running.${err ? ` (${err})` : ''}`;
    }
    try { return await client.callTool(tool.toolName, args); }
    catch (error) { return `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
  }

  dispose(): void {
    for (const client of this.clients.values()) { client.stop(); }
    this.clients.clear();
    this.tools.clear();
    this.statuses.clear();
    this.configs.clear();
    this.reconnecting.clear();
    this.reconnectAfter.clear();
    this.lastConfigJson = '';
  }

  private removeToolsFor(server: string): void {
    for (const [name, tool] of [...this.tools]) { if (tool.server === server) { this.tools.delete(name); } }
  }
}

/** Keep server/tool names to characters the model tool-name grammar accepts. */
function sanitize(name: string): string { return name.replace(/[^A-Za-z0-9_-]/g, '_'); }
