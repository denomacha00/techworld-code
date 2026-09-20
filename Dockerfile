# Railway (and any container host) uses this Dockerfile in preference to auto-detection, so the deploy
# runs ONLY the tiny update server — never the VS Code extension. This is the definitive fix for the
# `MODULE_NOT_FOUND ... /app/dist/extension.js` crash: Railway was auto-running the extension bundle,
# which requires VS Code's `vscode` module that does not exist on a plain server.
#
# Use this with the service's Root Directory left BLANK (repo root).
FROM node:20-alpine
WORKDIR /app
# Copy only the update server: its server.js (pure Node stdlib — nothing to npm install), the manifest,
# and the published .vsix files under releases/. No extension source, no dist/, no build step.
COPY update-server/ ./
# Railway injects PORT; server.js reads it (falls back to 8080 for local runs).
CMD ["node", "server.js"]
