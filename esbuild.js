const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');
const root = __dirname;
const outfile = path.join(root, 'dist/extension.js');

// Obfuscation is on by default for shipped builds. Skip it with SKIP_OBFUSCATE=1
// (faster rebuilds, readable stack traces) while developing.
const obfuscate = !watch && process.env.SKIP_OBFUSCATE !== '1';

const context = esbuild.context({
  entryPoints: [path.join(root, 'src/extension.ts')],
  bundle: true,
  outfile,
  external: ['vscode'],
  platform: 'node',
  format: 'cjs',
  // Sourcemaps only while developing (--watch). NEVER in a shipped build: a sourcemap
  // reconstructs the full original source (comments and all) and defeats minification.
  sourcemap: watch,
  minify: !watch,
  target: 'node20',
});

context
  .then((build) => (watch ? build.watch() : build.rebuild().then(() => build.dispose())))
  .then(() => { if (obfuscate) { runObfuscation(); } })
  .catch((error) => { console.error(error); process.exit(1); });

// Second pass: rename identifiers, encode every string into a shuffled, base64+RC4 array,
// and flatten control flow. This makes the shipped bundle genuinely hard to read or lift —
// far beyond esbuild's minify. It does NOT protect secrets that must exist at runtime
// (the endpoint is still reachable by watching network traffic) — deploy proxy/ for that.
function runObfuscation() {
  let JavaScriptObfuscator;
  try {
    JavaScriptObfuscator = require('javascript-obfuscator');
  } catch {
    console.warn('[build] javascript-obfuscator not installed — shipping minified-only bundle. Run: npm i -D javascript-obfuscator');
    return;
  }
  let code = fs.readFileSync(outfile, 'utf8');

  // CRITICAL: esbuild appends a DEAD export annotation `0 && (module.exports = { activate, deactivate })`.
  // Those bare names don't exist after minify (the functions are renamed), so the line only survives
  // because `0 &&` short-circuits it. The obfuscator's `simplify` pass can make that branch live, which
  // throws `ReferenceError: activate is not defined` at load and stops the extension from ever starting.
  // The real export (module.exports = __toCommonJS(...)) is a separate, earlier line and is untouched.
  // Strip the dead annotation before obfuscating so there's nothing to accidentally revive.
  const before = code;
  code = code.replace(/0\s*&&\s*\(module\.exports\s*=\s*\{[^}]*\}\)\s*;?/g, '');
  if (code === before) { console.warn('[build] WARNING: expected dead export annotation not found — esbuild output may have changed.'); }

  const result = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    // Control-flow flattening + dead code make the logic hard to follow. Kept LOW: on a large
    // bundle inside VS Code's extension host, high thresholds add real startup cost and can
    // make activation feel like it hangs. Low is plenty to defeat casual reading.
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.2,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.1,
    identifierNamesGenerator: 'hexadecimal',
    // Never rename the two names VS Code calls to start/stop the extension.
    reservedNames: ['^activate$', '^deactivate$'],
    numbersToExpressions: true,
    simplify: true,
    // Every string literal (URLs, messages, tool names) is pulled into an encrypted array
    // and fetched indirectly, so nothing is greppable in the shipped file. THIS is what hides
    // the worker URL — it stays. The real endpoint protection is the proxy, not this.
    stringArray: true,
    stringArrayEncoding: ['rc4'],
    stringArrayThreshold: 1,
    stringArrayWrappersType: 'function',
    stringArrayCallsTransform: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    transformObjectKeys: true,
    // selfDefending is DELIBERATELY OFF: its anti-tamper traps can spin into an infinite loop
    // in the extension host and freeze the view on load. Not worth the risk for an interactive
    // extension — the string encryption above already makes the bundle non-greppable.
    selfDefending: false,
    disableConsoleOutput: false,
    target: 'node',
  });
  fs.writeFileSync(outfile, result.getObfuscatedCode(), 'utf8');
  const kb = (fs.statSync(outfile).size / 1024).toFixed(1);
  console.log(`[build] obfuscated dist/extension.js (${kb} KB)`);
}
