# Techword Code update server

A tiny zero-dependency Node server that lets installed copies of the Techword Code extension update
themselves. VS Code only auto-updates extensions that come from a marketplace, so a self-hosted `.vsix`
needs this: the extension checks `latest.json`, and when a newer version is listed it downloads the
`.vsix` from here and installs it.

## What it serves

- `GET /latest.json` — the release manifest (which version is current, where its `.vsix` is).
- `GET /releases/techword-code-<version>.vsix` — the package files.
- `GET /health` — health check for Railway.

## Deploy to Railway

There is a **`Dockerfile`** at the repo root. Railway uses a Dockerfile in preference to everything else,
so the deploy runs ONLY this update server — the VS Code extension is never built or started. This is the
definitive fix for the `MODULE_NOT_FOUND ... /app/dist/extension.js` crash (Railway was auto-running the
extension bundle, which needs VS Code's `vscode` module that doesn't exist on a server).

1. Push this repo to GitHub.
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo**, pick this repo.
3. Open the service → **Settings**:
   - **Root Directory**: leave **blank** (repo root) so the root `Dockerfile` is used.
   - **Builder**: it should say *Dockerfile* once detected. If a previous failed deploy pinned a
     **Start Command** (e.g. `node dist/extension.js`), **clear it** — the Dockerfile provides `CMD`.
   - Railway sets `PORT` automatically — the server reads it.
4. **Deploy** (or **Redeploy** so it picks up the new commit — don't reuse the old cached build).
   Healthy log line: `Techword Code update server listening on :<PORT>`.
   Check `https://<your-app>.up.railway.app/health` → `{"ok":true,...}` and `/latest.json` → the manifest.
5. Put that URL (with `/latest.json`) into the extension:
   - Edit `src/TechwordConfig.ts` → `TECHWORD_UPDATE_URL = 'https://<your-app>.up.railway.app/latest.json'`
   - Rebuild + repackage the extension so the built-in default points at your server.
   - (Individual users can also override it without a rebuild via the `techwordCode.updateUrl` setting.)

If you prefer to set **Root Directory = `update-server`** instead, that also works: this folder has its own
`Dockerfile` and `railway.json`, no build step, and no dependencies. Either way the extension is never run.

## Publishing a new version

1. Bump `version` in the extension's `package.json`, build, and run `npm run package` to get
   `techword-code-<version>.vsix`.
2. Copy that `.vsix` into `update-server/releases/`.
3. Edit `update-server/latest.json`:
   ```json
   {
     "version": "1.8.1",
     "vsixUrl": "/releases/techword-code-1.8.1.vsix",
     "notes": "What changed in this release."
   }
   ```
4. Commit + push. Railway redeploys automatically.

Installed extensions pick it up on their next startup check (or when a user runs **Techword Code: Check
for Updates**). Users who turned on **auto-update** get it installed automatically, then a reload prompt.

`vsixUrl` may be a path relative to the manifest (as above) or a full `https://` URL if you host the
`.vsix` elsewhere (GitHub Releases, S3, etc.).
