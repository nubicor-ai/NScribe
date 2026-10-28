// NScribe server: serves the static app and proxies model calls so the API key stays on the server.
// Zero dependencies. Run: ANTHROPIC_API_KEY=... node server/index.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.NSCRIBE_MODEL || 'claude-sonnet-5-5';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_BODY = 400 * 1024;
const RATE = { windowMs: 60000, max: 20 };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  arr.push(now); hits.set(ip, arr);
  return arr.length > RATE.max;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function parseModelJson(text) {
  const t = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}

async function sample(req, res) {
  if (!API_KEY) return send(res, 503, { error: 'not_configured' });
  if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) return send(res, 401, { error: 'not_granted' });
  const ip = req.socket.remoteAddress || '';
  if (limited(ip)) return send(res, 429, { error: 'rate_limited' });

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) return send(res, 413, { error: 'too_large' });
  }
  let prompt;
  try { prompt = JSON.parse(body).prompt; } catch (e) {}
  if (typeof prompt !== 'string' || !prompt.trim()) return send(res, 400, { error: 'bad_request' });

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
      signal: ac.signal
    });
    if (r.status === 429) return send(res, 429, { error: 'rate_limited' });
    if (!r.ok) return send(res, 502, { error: 'upstream_' + r.status });
    const j = await r.json();
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const result = parseModelJson(text);
    if (!result || typeof result !== 'object') return send(res, 502, { error: 'invalid_json' });
    send(res, 200, { result });
  } catch (e) {
    if (!res.writableEnded) send(res, 502, { error: 'upstream_failed' });
  }
}

function serve(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': p === '/sw.js' || p === '/index.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/sample') return sample(req, res);
  if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { ok: true, ai: !!API_KEY, locked: !!ACCESS_CODE });
  if (req.method === 'GET' || req.method === 'HEAD') return serve(req, res);
  res.writeHead(405); res.end();
}).listen(PORT, () => console.log(`NScribe on http://localhost:${PORT} (AI ${API_KEY ? 'on' : 'off: set ANTHROPIC_API_KEY'})`));
