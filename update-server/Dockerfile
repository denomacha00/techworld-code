# Same as the repo-root Dockerfile, but for when the Railway service's Root Directory IS set to
# `update-server` (build context is this folder). Runs only the update server — no extension, no dist.
FROM node:20-alpine
WORKDIR /app
COPY . ./
CMD ["node", "server.js"]
