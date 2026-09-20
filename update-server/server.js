'use strict';
// Techword Code update server. Serves the release manifest (latest.json) and the .vsix files the
// extension downloads to self-update. Zero dependencies — plain Node http, so it deploys anywhere
// (Railway, Render, Fly, a VPS) with just `node server.js`. Railway sets PORT for you.
//
// Layout:
//   update-server/
//     server.js          (this file)
//     latest.json        (the manifest: which version is current + where its .vsix is)
//     releases/          (drop each techword-code-<version>.vsix here)
//
// To publish a new version: build the .vsix, copy it into releases/, bump latest.json, redeploy.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const RELEASES_DIR = path.join(ROOT, 'releases');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type'
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache', ...CORS });
  res.end(JSON.stringify(body));
}

function sendVsix(res, filePath) {
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': stat.size,
    'content-disposition': `attachment; filename="${path.basename(filePath)}"`,
    'cache-control': 'public, max-age=86400',
    ...CORS
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }

  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { sendJson(res, 400, { error: 'bad request' }); return; }

  // Health check for Railway / uptime probes.
  if (pathname === '/' || pathname === '/health') { sendJson(res, 200, { ok: true, service: 'techword-code-updates' }); return; }

  // The manifest. Served from latest.json so publishing is just a file edit.
  if (pathname === '/latest.json' || pathname === '/latest') {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'latest.json'), 'utf8'));
      sendJson(res, 200, manifest);
    } catch {
      sendJson(res, 500, { error: 'manifest unavailable' });
    }
    return;
  }

  // The .vsix downloads. Only files inside releases/ with a .vsix extension are served; the resolved
  // path is checked to stay inside releases/ so a crafted URL can't escape and read arbitrary files.
  if (pathname.startsWith('/releases/')) {
    const rel = pathname.slice('/releases/'.length);
    const filePath = path.join(RELEASES_DIR, rel);
    const normalized = path.normalize(filePath);
    if (!normalized.startsWith(RELEASES_DIR + path.sep) || !normalized.endsWith('.vsix') || !fs.existsSync(normalized)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendVsix(res, normalized);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => { console.log(`Techword Code update server listening on :${PORT}`); });
