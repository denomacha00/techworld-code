import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { type Checkpoint, type CommandProposal, type EditPreview, type FileEdit } from '../types';
import { contentHash, isSensitivePath, redact } from '../security/Redaction';
import { CODE_MAP_EXTENSIONS, rankFiles, type MapInput } from './CodeMap';

const execFileAsync = promisify(execFile);
const PREVIEW_CHAR_LIMIT = 60000;

const SYMBOL_KINDS = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'];
function symbolKind(kind: vscode.SymbolKind): string { return SYMBOL_KINDS[kind] ?? 'Symbol'; }

export class WorkspaceToolExecutor {
  private readonly checkpoints = new Map<string, Checkpoint>();
  private excludeGlob: string | undefined;

  constructor(private readonly outputLimit: number) {}

  /** Turn a set of search/replace edits into a single modify FileEdit, validating each match. */
  async computeStringEdit(path: string, edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>): Promise<FileEdit> {
    const uri = this.uri(path);
    const original = await this.readExisting(uri);
    if (original === undefined) { throw new Error(`Cannot edit ${path}: it does not exist. Use propose_file_edits to create it.`); }
    let content = original;
    for (const [index, edit] of edits.entries()) {
      if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') { throw new Error(`Edit ${index + 1} for ${path} is malformed.`); }
      if (edit.oldText === '') { throw new Error(`Edit ${index + 1} for ${path}: oldText cannot be empty.`); }
      const occurrences = content.split(edit.oldText).length - 1;
      if (occurrences === 0) { throw new Error(`Edit ${index + 1} for ${path}: oldText was not found. Re-read the file and copy the exact text (with indentation).`); }
      if (occurrences > 1 && !edit.replaceAll) { throw new Error(`Edit ${index + 1} for ${path}: oldText appears ${occurrences} times. Add more surrounding context to make it unique, or set replaceAll.`); }
      content = edit.replaceAll ? content.split(edit.oldText).join(edit.newText) : content.replace(edit.oldText, edit.newText);
    }
    if (content === original) { throw new Error(`No changes for ${path}: the edits left the file unchanged.`); }
    return { path, content, operation: 'modify' };
  }

  /** Build before/after content for each edit so the chat can render an inline diff. */
  async buildPreviews(edits: FileEdit[]): Promise<EditPreview[]> {
    const previews: EditPreview[] = [];
    for (const edit of edits) {
      const existing = (await this.readExisting(this.uri(edit.path))) ?? '';
      const newContent = edit.operation === 'delete' ? '' : edit.content;
      const truncated = existing.length > PREVIEW_CHAR_LIMIT || newContent.length > PREVIEW_CHAR_LIMIT;
      previews.push({
        path: edit.path,
        operation: edit.operation,
        renameTo: edit.renameTo,
        oldContent: existing.slice(0, PREVIEW_CHAR_LIMIT),
        newContent: newContent.slice(0, PREVIEW_CHAR_LIMIT),
        truncated
      });
    }
    return previews;
  }

  async listFiles(path = '.', depth = 3): Promise<string> {
    const root = this.root();
    const base = this.cleanRelative(path);
    const pattern = new vscode.RelativePattern(root, base === '.' ? '**/*' : `${base}/**/*`);
    const entries = await vscode.workspace.findFiles(pattern, await this.getExcludeGlob(), Math.min(1000, Math.max(1, depth) * 300));
    return entries.map((uri) => vscode.workspace.asRelativePath(uri, false)).filter((item) => !this.denied(item)).slice(0, 1000).join('\n');
  }

  /** Build a findFiles exclude glob from default noise dirs plus the workspace .gitignore. */
  private async getExcludeGlob(): Promise<string> {
    if (this.excludeGlob) { return this.excludeGlob; }
    const patterns = new Set<string>(['**/.git/**', '**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**', '**/.next/**', '**/coverage/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/target/**', '**/.gradle/**', '**/vendor/**', '**/.turbo/**', '**/.cache/**']);
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.root().uri, '.gitignore'));
      for (const raw of Buffer.from(data).toString('utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!') || line.includes(',') || line.includes('{')) { continue; }
        let p = line;
        const dirOnly = p.endsWith('/');
        if (dirOnly) { p = p.slice(0, -1); }
        const anchored = p.startsWith('/');
        p = p.replace(/^\/+|\/+$/g, '');
        if (!p) { continue; }
        const bare = anchored ? p : `**/${p}`;
        if (dirOnly) { patterns.add(`${bare}/**`); } else { patterns.add(bare); patterns.add(`${bare}/**`); }
      }
    } catch { /* no .gitignore */ }
    this.excludeGlob = `{${[...patterns].join(',')}}`;
    return this.excludeGlob;
  }

  async readFile(path: string, startLine = 1, endLine = 400): Promise<string> {
    const uri = this.uri(path);
    const relative = vscode.workspace.asRelativePath(uri, false);
    if (this.denied(relative)) { throw new Error('This path is protected and cannot be sent to a provider.'); }
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    void this.reveal(uri, false); // show the file being read (in the background)
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, startLine);
    const end = Math.min(lines.length, Math.max(start, endLine));
    return redact(lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n')).slice(0, this.outputLimit);
  }

  /** Open a file in the editor so the user can watch reads/edits happen. `focus` brings it to front. */
  private async reveal(uri: vscode.Uri, focus: boolean): Promise<void> {
    if (!vscode.workspace.getConfiguration('techwordCode').get<boolean>('openFilesInEditor', true)) { return; }
    const options = { preview: true, preserveFocus: !focus, viewColumn: vscode.ViewColumn.One };
    try {
      await vscode.window.showTextDocument(uri, options);
    } catch {
      try { await vscode.commands.executeCommand('vscode.open', uri, options); } catch { /* ignore reveal failures */ }
    }
  }

  async gitStatus(): Promise<string> { return this.git(['status', '--short']); }
  async gitDiff(path?: string): Promise<string> { return this.git(path ? ['diff', '--', this.cleanRelative(path)] : ['diff']); }

  /** Read the editor's diagnostics (Problems) — compiler/linter errors and warnings. */
  getDiagnostics(path?: string, errorsOnly = false): string {
    const root = this.root();
    const severityName = ['error', 'warning', 'info', 'hint'];
    const scopePath = path?.trim() ? this.cleanRelative(path) : '';
    const lines: string[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (!uri.path.startsWith(root.uri.path)) { continue; }
      if (scopePath && rel !== scopePath) { continue; }
      for (const diag of diags) {
        if (errorsOnly && diag.severity !== vscode.DiagnosticSeverity.Error) { continue; }
        lines.push(`${rel}:${diag.range.start.line + 1}:${diag.range.start.character + 1}: ${severityName[diag.severity] ?? 'info'}: ${diag.message.split('\n')[0]}`);
        if (lines.length >= 300) { break; }
      }
      if (lines.length >= 300) { break; }
    }
    return lines.length > 0 ? redact(lines.join('\n')).slice(0, this.outputLimit) : 'No problems reported by the editor.';
  }

  /** Find where a symbol (class/function/etc.) is defined across the workspace, by name. */
  async findSymbol(query: string): Promise<string> {
    this.root();
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query);
    if (!symbols || symbols.length === 0) { return `No symbols matching "${query}". Try search_workspace for a text search.`; }
    const lines = symbols.slice(0, 100).map((s) => {
      const rel = vscode.workspace.asRelativePath(s.location.uri, false);
      return `${symbolKind(s.kind)} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''} — ${rel}:${s.location.range.start.line + 1}`;
    });
    return redact(lines.join('\n')).slice(0, this.outputLimit);
  }

  /** Show a file's structure (classes, functions, methods) without reading the whole file — good for large files. */
  async outlineFile(path: string): Promise<string> {
    const uri = this.uri(path);
    if (this.denied(vscode.workspace.asRelativePath(uri, false))) { throw new Error('This path is protected.'); }
    const doc = await vscode.workspace.openTextDocument(uri);
    const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>('vscode.executeDocumentSymbolProvider', uri);
    if (!symbols || symbols.length === 0) { return `No symbols found in ${path} (language server may not support it). Use read_file instead.`; }
    const lines: string[] = [];
    const walk = (items: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, depth: number): void => {
      for (const item of items) {
        const range = 'selectionRange' in item ? item.selectionRange : item.location.range;
        lines.push(`${'  '.repeat(depth)}${symbolKind(item.kind)} ${item.name} — line ${range.start.line + 1}`);
        if ('children' in item && item.children.length > 0) { walk(item.children, depth + 1); }
      }
    };
    walk(symbols, 0);
    void this.reveal(uri, false);
    return redact(`${path} (${doc.lineCount} lines)\n${lines.join('\n')}`).slice(0, this.outputLimit);
  }

  /** List all references (uses) of the symbol at a given line, plus its definition. */
  async findUsages(path: string, line: number, symbol?: string): Promise<string> {
    const uri = this.uri(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const lineIndex = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
    const lineText = doc.lineAt(lineIndex).text;
    const col = symbol ? Math.max(lineText.indexOf(symbol), 0) : Math.max(lineText.search(/\S/), 0);
    const position = new vscode.Position(lineIndex, col);
    const [defs, refs] = await Promise.all([
      vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>('vscode.executeDefinitionProvider', uri, position),
      vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, position)
    ]);
    const fmt = (loc: vscode.Location | vscode.LocationLink): string => {
      const u = 'targetUri' in loc ? loc.targetUri : loc.uri;
      const r = 'targetRange' in loc ? loc.targetRange : loc.range;
      return `${vscode.workspace.asRelativePath(u, false)}:${r.start.line + 1}`;
    };
    const defLines = (defs ?? []).map((d) => `  def: ${fmt(d)}`);
    const refLines = (refs ?? []).slice(0, 200).map((r) => `  ref: ${fmt(r)}`);
    const out = [...defLines, ...refLines];
    return out.length > 0 ? redact(out.join('\n')).slice(0, this.outputLimit) : 'No definition or references found at that location (language server may not support it).';
  }

  /** Fetch a web page/API over HTTP(S) and return readable text (docs, npm, references). */
  async webFetch(url: string): Promise<string> {
    let target: URL;
    try { target = new URL(url); } catch { throw new Error('That is not a valid URL.'); }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') { throw new Error('Only http(s) URLs can be fetched.'); }
    let response: Response;
    try {
      response = await fetch(target.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TechwordCode)', Accept: 'text/html,application/json,text/plain,*/*' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
    } catch (error) { return `Could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`; }
    if (!response.ok) { return `Fetch of ${url} returned HTTP ${response.status}.`; }
    const contentType = response.headers.get('content-type') ?? '';
    let text = await response.text();
    if (/html/i.test(contentType)) {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    }
    return redact(`${target.toString()}\n\n${text}`).slice(0, this.outputLimit);
  }

  /** Read an image or SVG as a data URL so the chat can display it inline. */
  async previewDataUrl(path: string): Promise<{ dataUrl: string; name: string }> {
    const uri = this.uri(path);
    const name = path.replace(/\\/g, '/').split('/').at(-1) ?? 'file';
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (ext === 'svg') { return { dataUrl: `data:image/svg+xml;base64,${Buffer.from(bytes).toString('base64')}`, name }; }
    const imageExt: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
    const mime = imageExt[ext];
    if (!mime) { throw new Error('preview_in_chat only supports images (png/jpg/gif/webp/bmp) and .svg files.'); }
    return { dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, name };
  }

  /** Build a high-level map of the codebase: the most important files (ranked by how many other
   *  files reference them) with their key top-level symbols. Fast and dependency-free — regex symbol
   *  extraction + a reference graph, so it scales to very large repos without reading everything fully. */
  async codeMap(scope = '', maxFiles = 120): Promise<string> {
    const root = this.root();
    const base = scope.trim() ? this.cleanRelative(scope) : '';
    const pattern = new vscode.RelativePattern(root, base ? `${base}/**/*` : '**/*');
    const uris = await vscode.workspace.findFiles(pattern, await this.getExcludeGlob(), 6000);
    const inputs: MapInput[] = [];
    for (const uri of uris) {
      if (inputs.length >= 4000) { break; } // cap work on very large repos
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (this.denied(rel)) { continue; }
      const ext = rel.split('.').pop()?.toLowerCase() ?? '';
      if (!CODE_MAP_EXTENSIONS.has(ext)) { continue; }
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 400000) { continue; } // skip very large/generated files
        const text = Buffer.from(bytes).toString('utf8');
        if (text.includes(String.fromCharCode(0))) { continue; }
        inputs.push({ rel, text });
      } catch { continue; }
    }
    if (inputs.length === 0) { return 'No source files found to map in that scope.'; }

    const ranked = rankFiles(inputs, maxFiles);
    const lines = [`Code map — ${inputs.length} source file(s)${base ? ` under ${base}` : ''}, top ${ranked.length} by connectivity:`, ''];
    for (const file of ranked) {
      const symbols = file.symbols.slice(0, 12).join(', ');
      lines.push(`${file.rel}  [${file.refs} ref${file.refs === 1 ? '' : 's'}]${symbols ? `\n    ${symbols}` : ''}`);
    }
    return redact(lines.join('\n')).slice(0, this.outputLimit);
  }

  /** Search file contents across the workspace for a string or regex; returns path:line matches. */
  async searchText(query: string, options: { regex?: boolean; include?: string; maxResults?: number }): Promise<string> {
    const root = this.root();
    const scope = options.include?.trim() ? this.cleanRelative(options.include) : '';
    const glob = !scope ? '**/*' : scope.includes('*') ? scope : `${scope}/**/*`;
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, glob), await this.getExcludeGlob(), 5000);
    const max = Math.min(Math.max(options.maxResults ?? 100, 1), 300);
    let matcher: RegExp | undefined;
    if (options.regex) {
      try { matcher = new RegExp(query, 'i'); } catch (error) { throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const needle = query.toLowerCase();
    const results: string[] = [];
    for (const uri of files) {
      if (results.length >= max) { break; }
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (this.denied(rel)) { continue; }
      let text: string;
      try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { continue; }
      if (text.includes(String.fromCharCode(0))) { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(needle);
        if (hit) {
          results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          if (results.length >= max) { break; }
        }
      }
    }
    return redact(results.length ? results.join('\n') : 'No matches found.').slice(0, this.outputLimit);
  }

  /** Apply approved edits and record a checkpoint of the prior state so the change can be reverted. */
  async applyEdits(edits: FileEdit[]): Promise<string> {
    const workspaceEdit = new vscode.WorkspaceEdit();
    const before: Array<{ path: string; before: string | null }> = [];
    for (const edit of edits) {
      const target = this.uri(edit.path);
      const existing = await this.readExisting(target);
      this.assertExpectedHash(edit, existing);
      before.push({ path: edit.path, before: existing ?? null });
      if (edit.operation === 'delete') { workspaceEdit.deleteFile(target, { ignoreIfNotExists: false }); }
      else if (edit.operation === 'rename') {
        if (!edit.renameTo) { throw new Error(`Cannot rename ${edit.path}: renameTo is missing.`); }
        before.push({ path: edit.renameTo, before: (await this.readExisting(this.uri(edit.renameTo))) ?? null });
        workspaceEdit.renameFile(target, this.uri(edit.renameTo), { overwrite: false, ignoreIfExists: false });
      }
      else if (edit.operation === 'create') { workspaceEdit.createFile(target, { ignoreIfExists: false }); workspaceEdit.insert(target, new vscode.Position(0, 0), edit.content); }
      else { workspaceEdit.replace(target, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(Number.MAX_SAFE_INTEGER, 0)), edit.content); }
    }
    if (!await vscode.workspace.applyEdit(workspaceEdit)) { throw new Error('VS Code rejected the approved file edit.'); }
    const id = randomUUID();
    this.checkpoints.set(id, { id, files: before });
    // Show the edited file so the user sees the change land in the editor.
    const shown = edits.find((edit) => edit.operation !== 'delete');
    if (shown) { void this.reveal(this.uri(shown.operation === 'rename' && shown.renameTo ? shown.renameTo : shown.path), true); }
    return id;
  }

  /** Restore files to the state captured in a checkpoint (undo an applied edit). */
  async restoreCheckpoint(id: string): Promise<string> {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) { throw new Error('That checkpoint is no longer available.'); }
    for (const file of checkpoint.files) {
      const uri = this.uri(file.path);
      if (file.before === null) { try { await vscode.workspace.fs.delete(uri, { useTrash: false }); } catch { /* already gone */ } }
      else { await vscode.workspace.fs.writeFile(uri, Buffer.from(file.before, 'utf8')); }
    }
    const first = checkpoint.files.find((file) => file.before !== null);
    if (first) { void this.reveal(this.uri(first.path), true); }
    return `Reverted ${checkpoint.files.length} file(s) to the state before that change.`;
  }

  async runCommand(proposal: CommandProposal, signal?: AbortSignal): Promise<string> {
    const root = this.root();
    const cwd = proposal.cwd ? this.uri(proposal.cwd).fsPath : root.uri.fsPath;
    const timeout = Math.min(Math.max(proposal.timeoutMs ?? 120000, 1000), 600000);
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', proposal.command] : ['-lc', proposal.command];
    try {
      // `signal` lets Stop kill a running command's child process.
      const { stdout, stderr } = await execFileAsync(shell, args, { cwd, timeout, windowsHide: true, signal, killSignal: 'SIGTERM', env: { ...process.env, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined } });
      return redact(`${stdout}${stderr ? `\n${stderr}` : ''}`).slice(0, this.outputLimit);
    } catch (error) {
      if (signal?.aborted) { return 'Command stopped by user.'; }
      const detail = error instanceof Error ? error.message : String(error);
      return redact(`Command failed: ${detail}`).slice(0, this.outputLimit);
    }
  }

  private root(): vscode.WorkspaceFolder {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { throw new Error('Open a trusted workspace folder before using workspace tools.'); }
    if (!vscode.workspace.isTrusted) { throw new Error('Workspace tools are disabled until you trust this workspace.'); }
    return folder;
  }

  private uri(path: string): vscode.Uri {
    const root = this.root();
    const clean = this.cleanRelative(path);
    const target = vscode.Uri.joinPath(root.uri, clean);
    if (!target.path.startsWith(root.uri.path.endsWith('/') ? root.uri.path : `${root.uri.path}/`) && target.path !== root.uri.path) { throw new Error('Path escapes the workspace.'); }
    if (this.denied(clean)) { throw new Error('This path is protected.'); }
    return target;
  }

  private cleanRelative(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.split('/').includes('..')) { throw new Error('Use a non-empty workspace-relative path.'); }
    return normalized;
  }

  private denied(path: string): boolean {
    const config = vscode.workspace.getConfiguration('techwordCode');
    const denied = config.get<string[]>('deniedGlobs', []);
    return path.split('/').includes('.git') || isSensitivePath(path) || denied.some((pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`, 'i').test(path));
  }

  private async readExisting(uri: vscode.Uri): Promise<string | undefined> {
    try { return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { return undefined; }
  }

  private assertExpectedHash(edit: FileEdit, content: string | undefined): void {
    if (edit.operation === 'create' && content !== undefined) { throw new Error(`Cannot create ${edit.path}: it already exists.`); }
    if (edit.operation !== 'create' && content === undefined) { throw new Error(`Cannot ${edit.operation} ${edit.path}: it no longer exists.`); }
    if (edit.expectedHash && content !== undefined && edit.expectedHash !== contentHash(content)) { throw new Error(`${edit.path} changed after the proposal was created. Ask the agent to read it again.`); }
  }

  private async git(args: string[]): Promise<string> {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd: this.root().uri.fsPath, timeout: 30000, windowsHide: true });
    return redact(`${stdout}${stderr ? `\n${stderr}` : ''}`).slice(0, this.outputLimit);
  }
}
