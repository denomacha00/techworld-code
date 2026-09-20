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

**Set the service's Root Directory to `update-server`.** That is the one setting that makes this reliable:
it points Railway at THIS folder only, so it never sees the VS Code extension's build.

> If you deploy the repo root instead, Railway auto-detects the extension's `package.json`, whose `main`
> is `./dist/extension.js`, and tries to run that bundle — which needs VS Code's `vscode` module and
> crashes with `MODULE_NOT_FOUND ... /app/dist/extension.js`. Pointing Root Directory at `update-server`
> avoids that entirely: this folder has no build step and no dependencies, and `railway.json` here pins
> the start command to `node server.js`.

1. Push this repo to GitHub.
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo**, pick this repo.
3. Open the service → **Settings**:
   - **Root Directory**: `update-server`   ← the important one
   - **Start Command**: leave blank (the folder's `railway.json` sets `node server.js`). If a previous
     failed deploy left a custom Start Command here, clear it.
   - Railway sets `PORT` automatically — the server reads it.
4. **Deploy** (or redeploy). Healthy log line: `Techword Code update server listening on :<PORT>`.
   Check `https://<your-app>.up.railway.app/health` → `{"ok":true,...}` and `/latest.json` → the manifest.
5. Put that URL (with `/latest.json`) into the extension:
   - Edit `src/TechwordConfig.ts` → `TECHWORD_UPDATE_URL = 'https://<your-app>.up.railway.app/latest.json'`
   - Rebuild + repackage the extension so the built-in default points at your server.
   - (Individual users can also override it without a rebuild via the `techwordCode.updateUrl` setting.)

The repo root also has a `nixpacks.toml` as a fallback for a blank-Root-Directory deploy, but **Root
Directory = `update-server` is the recommended, dependable path** — use it if you saw the dist/MODULE
crash.

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
