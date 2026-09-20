import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpHub } from '../src/mcp/McpHub';

// A minimal MCP server (newline-delimited JSON-RPC over stdio) written to a temp file and run with
// `node`. Exercises the real handshake, tools/list, and tools/call paths of McpClient/McpHub.
const MOCK_SERVER = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echoes text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
    } else if (msg.method === 'tools/call') {
      const text = msg.params && msg.params.arguments && msg.params.arguments.text;
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + text }] } });
    }
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
`;

function writeMockServer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-mcp-'));
  const file = join(dir, 'mock-server.js');
  writeFileSync(file, MOCK_SERVER, 'utf8');
  return file;
}

test('isMcpTool recognises namespaced tool names', () => {
  assert.equal(McpHub.isMcpTool('mcp__mock__echo'), true);
  assert.equal(McpHub.isMcpTool('read_file'), false);
});

test('a fresh hub exposes no tools', () => {
  const hub = new McpHub();
  assert.equal(hub.hasTools(), false);
  assert.deepEqual(hub.toolDefinitions(), []);
});

test('hub connects to a server, discovers tools, and calls one', async () => {
  const server = writeMockServer();
  const hub = new McpHub();
  try {
    await hub.sync({ mock: { command: process.execPath, args: [server] } });
    assert.equal(hub.hasTools(), true);
    const defs = hub.toolDefinitions();
    const echo = defs.find((d) => d.name === 'mcp__mock__echo');
    assert.ok(echo, 'echo tool should be discovered and namespaced');
    assert.equal(echo?.description, 'Echoes text back');

    const status = hub.statusList().find((s) => s.server === 'mock');
    assert.equal(status?.running, true);
    assert.equal(status?.toolCount, 1);

    const result = await hub.callTool('mcp__mock__echo', { text: 'hello' });
    assert.equal(result, 'echo: hello');
  } finally {
    hub.dispose();
  }
});

test('hub reports an error for a server that cannot start', async () => {
  const hub = new McpHub();
  try {
    await hub.sync({ broken: { command: 'this-command-does-not-exist-techword', args: [] } });
    assert.equal(hub.hasTools(), false);
    const status = hub.statusList().find((s) => s.server === 'broken');
    assert.equal(status?.running, false);
    assert.ok(status?.error, 'a start failure should be recorded');
  } finally {
    hub.dispose();
  }
});

test('disabled servers are not started', async () => {
  const server = writeMockServer();
  const hub = new McpHub();
  try {
    await hub.sync({ mock: { command: process.execPath, args: [server], disabled: true } });
    assert.equal(hub.hasTools(), false);
  } finally {
    hub.dispose();
  }
});
