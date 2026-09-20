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

The repo root has a `nixpacks.toml` that tells Railway to skip building the VS Code extension and just run
this server. **Leave "Root Directory" BLANK** (repo root) and it works — no other build settings needed.

> Why: without that file Railway auto-detects the root `package.json` (the extension) and runs its
> `build` script (`node esbuild.js`), which fails on Railway ("dist error"). The `nixpacks.toml` overrides
> the install/build steps to do nothing and starts `node update-server/server.js` instead. The server is
> pure Node standard library, so there is nothing to install.

1. Push this repo to GitHub.
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo**, pick this repo.
3. In the service **Settings**, leave **Root Directory** blank. (Railway sets `PORT` automatically — the
   server reads it. Don't set a custom Start Command; `nixpacks.toml` provides it.)
4. Deploy. Railway gives you a public URL, e.g. `https://techword-updates.up.railway.app`.
5. Put that URL (with `/latest.json`) into the extension:
   - Edit `src/TechwordConfig.ts` → `TECHWORD_UPDATE_URL = 'https://<your-app>.up.railway.app/latest.json'`
   - Rebuild + repackage the extension so the built-in default points at your server.
   - (Individual users can also override it without a rebuild via the `techwordCode.updateUrl` setting.)

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
