'use strict';
/*
 * One-command release for Techword Code.
 *
 *   node scripts/publish.js <version> ["release notes"]
 *   node scripts/publish.js patch                        (auto-bump the patch number)
 *
 * It does everything needed to push an update to every installed client:
 *   1. sets the new version in package.json
 *   2. builds an UN-obfuscated bundle and fails if any upstream name leaked (white-label safety)
 *   3. builds + packages the real (obfuscated) .vsix
 *   4. copies the .vsix into update-server/releases/ and removes the previous one
 *   5. writes update-server/latest.json with the new version + notes
 *   6. commits and pushes — Railway redeploys and clients self-update on next startup
 *
 * Requires a clean-ish tree (it commits whatever is staged for the release).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
const capture = (cmd) => execSync(cmd, { cwd: root }).toString();

function fail(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }

function nextVersion(current, arg) {
  if (!arg || arg === 'patch') {
    const [a, b, c] = current.split('.').map((n) => parseInt(n, 10) || 0);
    return `${a}.${b}.${c + 1}`;
  }
  if (arg === 'minor') { const [a, b] = current.split('.').map((n) => parseInt(n, 10) || 0); return `${a}.${b + 1}.0`; }
  if (arg === 'major') { const [a] = current.split('.').map((n) => parseInt(n, 10) || 0); return `${a + 1}.0.0`; }
  if (!/^\d+\.\d+\.\d+$/.test(arg)) { fail(`"${arg}" is not a version (use 1.8.2, or patch/minor/major).`); }
  return arg;
}

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = nextVersion(pkg.version, process.argv[2]);
const notes = process.argv[3] || `Techword Code ${version}.`;
const vsixName = `techword-code-${version}.vsix`;
const releasesDir = path.join(root, 'update-server', 'releases');

console.log(`\n▶ Publishing Techword Code ${pkg.version} → ${version}\n`);

// 1. bump version
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 2. white-label leak check on an un-obfuscated bundle (plaintext grep of the obfuscated bundle is
//    always 0, so it must be run against the readable build to be meaningful).
console.log('▶ Leak check (un-obfuscated bundle)…');
run('node esbuild.js', { env: { ...process.env, SKIP_OBFUSCATE: '1' }, stdio: 'ignore' });
const bundle = fs.readFileSync(path.join(root, 'dist', 'extension.js'), 'utf8');
const leaks = ['justwoker', 'replay-aigateway'].filter((needle) => bundle.toLowerCase().includes(needle));
if (leaks.length) { fail(`Upstream name(s) leaked into the bundle: ${leaks.join(', ')}. Aborting — nothing published.`); }
console.log('  ✓ no upstream names in the bundle');

// 3. build + package the real (obfuscated) .vsix
console.log('\n▶ Packaging the obfuscated .vsix…');
run('npm run package');

// 4. move the .vsix into the release server, drop older release builds
fs.mkdirSync(releasesDir, { recursive: true });
for (const file of fs.readdirSync(releasesDir)) {
  if (file.endsWith('.vsix')) { fs.rmSync(path.join(releasesDir, file)); }
}
fs.copyFileSync(path.join(root, vsixName), path.join(releasesDir, vsixName));
console.log(`  ✓ staged ${vsixName} in update-server/releases/`);

// 5. write the manifest the extension checks — include the .vsix SHA-256 so the client verifies the
//    download's integrity before installing (a tampered/corrupt package is refused).
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(releasesDir, vsixName))).digest('hex');
const manifest = { version, vsixUrl: `/releases/${vsixName}`, notes, sha256 };
fs.writeFileSync(path.join(root, 'update-server', 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`  ✓ updated update-server/latest.json (sha256 ${sha256.slice(0, 12)}…)`);

// 6. commit + push — Railway redeploys, clients self-update
console.log('\n▶ Committing and pushing…');
run('git add -A');
try { run(`git commit -m "Release v${version}"`); }
catch { fail('git commit failed (nothing to commit, or a hook rejected it).'); }
run('git push origin HEAD');

const remote = capture('git remote get-url origin').trim();
console.log(`\n✓ Published v${version}.`);
console.log('  Railway will redeploy from the push; clients pick it up on next startup.');
console.log(`  Verify: <your-app>.up.railway.app/latest.json shows "${version}".`);
console.log(`  Repo: ${remote}\n`);
