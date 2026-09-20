import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbols, rankFiles, CODE_MAP_EXTENSIONS } from '../src/tools/CodeMap';

test('extractSymbols finds classes, functions, and arrow consts', () => {
  const src = `
export class UserService {}
export function loadUser(id) {}
export const makeClient = (opts) => ({});
interface Repo {}
type Id = string;
`;
  const symbols = extractSymbols(src);
  assert.ok(symbols.includes('UserService'));
  assert.ok(symbols.includes('loadUser'));
  assert.ok(symbols.includes('makeClient'));
  assert.ok(symbols.includes('Repo'));
  assert.ok(symbols.includes('Id'));
});

test('extractSymbols finds Python and Go style definitions', () => {
  const py = extractSymbols('def handler(req):\n    pass\nclass Widget:\n    pass');
  assert.ok(py.includes('handler'));
  assert.ok(py.includes('Widget'));
  const go = extractSymbols('func ServeHTTP(w, r) {}\ntype Server struct {}');
  assert.ok(go.includes('ServeHTTP'));
  assert.ok(go.includes('Server'));
});

test('extractSymbols ignores control-flow keywords', () => {
  const symbols = extractSymbols('if (x) {}\nfor (;;) {}\nwhile (true) {}');
  assert.equal(symbols.includes('if'), false);
  assert.equal(symbols.includes('for'), false);
  assert.equal(symbols.includes('while'), false);
});

test('rankFiles ranks a widely-referenced file above a leaf file', () => {
  const inputs = [
    { rel: 'src/core.ts', text: 'export class Core {}' },
    { rel: 'src/a.ts', text: 'import { Core } from "./core"; const a = new Core();' },
    { rel: 'src/b.ts', text: 'import { Core } from "./core"; const b = new Core();' },
    { rel: 'src/leaf.ts', text: 'const x = 1;' }
  ];
  const ranked = rankFiles(inputs, 10);
  assert.equal(ranked[0]?.rel, 'src/core.ts');
  assert.ok((ranked[0]?.refs ?? 0) >= 2);
  const leaf = ranked.find((f) => f.rel === 'src/leaf.ts');
  assert.equal(leaf?.refs, 0);
});

test('rankFiles respects the maxFiles cap', () => {
  const inputs = Array.from({ length: 50 }, (_, i) => ({ rel: `src/f${i}.ts`, text: `export const v${i} = ${i};` }));
  const ranked = rankFiles(inputs, 10);
  assert.equal(ranked.length, 10);
});

test('entry-point filenames get a ranking boost', () => {
  const inputs = [
    { rel: 'src/index.ts', text: 'const a = 1;' },
    { rel: 'src/random.ts', text: 'const b = 1;' }
  ];
  const ranked = rankFiles(inputs, 10);
  assert.equal(ranked[0]?.rel, 'src/index.ts');
});

test('code map extensions cover common languages', () => {
  for (const ext of ['ts', 'py', 'go', 'rs', 'java', 'rb']) {
    assert.ok(CODE_MAP_EXTENSIONS.has(ext), `${ext} should be mapped`);
  }
});
