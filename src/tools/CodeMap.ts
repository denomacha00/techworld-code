// Pure, dependency-free logic for the code map (no vscode import) so it can be unit-tested.
// The executor walks the workspace and feeds file contents in; this module extracts symbols,
// builds a reference graph, and ranks the most important files.

export const CODE_MAP_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php', 'swift', 'scala', 'dart', 'vue', 'svelte'
]);

// Language-agnostic top-level symbol extraction — regex-based, no parser dependency.
const SYMBOL_PATTERNS: RegExp[] = [
  /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/g,
  /(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  /(?:public|private|protected|static|internal)\s+(?:[A-Za-z_$][\w$<>,\s]*\s+)?([A-Za-z_$][\w$]*)\s*\(/g,
  /def\s+([A-Za-z_$][\w$]*)\s*\(/g,                     // Python / Ruby
  /func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/g,   // Go / Swift
  /(?:struct|trait|impl)\s+([A-Za-z_$][\w$]*)/g,        // Rust / C
  /type\s+([A-Za-z_$][\w$]*)\s+(?:struct|interface)\b/g // Go: type X struct
];

const NOT_SYMBOLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'const', 'let', 'var', 'new', 'await', 'typeof']);

/** Extract up to 40 distinct top-level symbol names from a source file's text. */
export function extractSymbols(text: string): string[] {
  const names = new Set<string>();
  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    let guard = 0;
    while ((match = pattern.exec(text)) !== null && guard < 500) {
      guard += 1;
      const name = match[1];
      if (name && name.length > 1 && !NOT_SYMBOLS.has(name)) { names.add(name); }
      if (names.size >= 40) { return [...names]; }
    }
  }
  return [...names];
}

export interface MapInput { rel: string; text: string; }
export interface RankedFile { rel: string; symbols: string[]; refs: number; score: number; }

const IMPORTANT_PATH = /(^|\/)(index|main|app|server|routes?|api|core|config|extension)\b/i;

/** Given files (path + contents), rank them by how many other files reference them (import graph
 *  approximated by filename mentions), plus symbol density and well-known entry-point names. */
export function rankFiles(inputs: MapInput[], maxFiles: number): RankedFile[] {
  const files = inputs.map((input) => ({
    rel: input.rel,
    stem: (input.rel.split('/').pop() ?? input.rel).replace(/\.[^.]+$/, ''),
    symbols: extractSymbols(input.text),
    text: input.text,
    refs: 0
  }));
  const stemToIndex = new Map<string, number[]>();
  files.forEach((file, index) => {
    if (!stemToIndex.has(file.stem)) { stemToIndex.set(file.stem, []); }
    stemToIndex.get(file.stem)?.push(index);
  });

  for (let i = 0; i < files.length; i += 1) {
    const body = files[i]?.text ?? '';
    const seen = new Set<number>();
    for (const [stem, indices] of stemToIndex) {
      if (stem.length < 3) { continue; }
      if (!new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body)) { continue; }
      for (const target of indices) { if (target !== i) { seen.add(target); } }
    }
    for (const target of seen) {
      const file = files[target];
      if (file) { file.refs += 1; }
    }
  }

  return files
    .map((file) => ({
      rel: file.rel,
      symbols: file.symbols,
      refs: file.refs,
      score: file.refs * 3 + file.symbols.length + (IMPORTANT_PATH.test(file.rel) ? 5 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
    .slice(0, Math.min(Math.max(maxFiles, 10), 400));
}
