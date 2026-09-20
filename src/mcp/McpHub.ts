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
  private lastConfigJson = '';

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
      if (!wanted.has(name)) { client.stop(); this.clients.delete(name); this.statuses.delete(name); this.removeToolsFor(name); }
    }

    // Start servers that are newly configured (leave already-running ones alone).
    await Promise.all([...wanted].map(async ([name, server]) => {
      if (this.clients.has(name)) { return; }
      const client = new McpClient(name, server);
      this.clients.set(name, client);
      try {
        await client.start();
        const defs = await client.listTools();
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
        this.log(`MCP server "${name}" connected with ${defs.length} tool(s).`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        client.stop();
        this.clients.delete(name);
        this.statuses.set(name, { server: name, running: false, toolCount: 0, error: message });
        this.log(`MCP server "${name}" failed: ${message}`);
      }
    }));
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
    const client = this.clients.get(tool.server);
    if (!client || !client.isRunning) { return `Tool error: MCP server "${tool.server}" is not running.`; }
    try { return await client.callTool(tool.toolName, args); }
    catch (error) { return `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
  }

  dispose(): void {
    for (const client of this.clients.values()) { client.stop(); }
    this.clients.clear();
    this.tools.clear();
    this.statuses.clear();
    this.lastConfigJson = '';
  }

  private removeToolsFor(server: string): void {
    for (const [name, tool] of [...this.tools]) { if (tool.server === server) { this.tools.delete(name); } }
  }
}

/** Keep server/tool names to characters the model tool-name grammar accepts. */
function sanitize(name: string): string { return name.replace(/[^A-Za-z0-9_-]/g, '_'); }
