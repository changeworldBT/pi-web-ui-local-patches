import http from 'node:http';
import fs from 'node:fs';

const BACKEND_HTTP = 'http://127.0.0.1:8787';
const BACKEND_WS = 'ws://127.0.0.1:8787/ws';
const PORT = Number(process.env.BRIDGE_PORT || 8789);
const POLL_MS = Number(process.env.BRIDGE_POLL_MS || 20000);
// 内存护栏（2026-10-31 02:53 OOM：堆 2GB，FatalProcessOutOfMemory @ DecodeUTF8）。
// 根因：sessions Map 只在页面主动调 /bridge/close 时才删；页面异常退出后 inbox 无限积压。
const INBOX_MAX_MSGS = Number(process.env.BRIDGE_INBOX_MAX_MSGS || 2000);
const INBOX_MAX_BYTES = Number(process.env.BRIDGE_INBOX_MAX_BYTES || 64 * 1024 * 1024);
const SESSION_TTL_MS = Number(process.env.BRIDGE_SESSION_TTL_MS || 6 * 3600 * 1000);
const SESSION_SWEEP_MS = Number(process.env.BRIDGE_SESSION_SWEEP_MS || 10 * 60 * 1000);
const SHIM = fs.readFileSync(new URL('./shim.js', import.meta.url), 'utf8');
const sessions = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function dropOldest(s) {
  while (s.inbox.length > INBOX_MAX_MSGS || s.inboxBytes > INBOX_MAX_BYTES) {
    const dropped = s.inbox.shift();
    s.inboxBytes -= dropped ? Buffer.byteLength(dropped) : 0;
  }
}

function ensureSession(sid, token) {
  let s = sessions.get(sid);
  if (s) { s.lastSeen = Date.now(); return s; }
  s = { sid, inbox: [], inboxBytes: 0, outbox: [], waiters: [], ws: null, closed: false, lastSeen: Date.now() };
  sessions.set(sid, s);
  try {
    const ws = new WebSocket(BACKEND_WS + '?token=' + encodeURIComponent(token));
    s.ws = ws;
    ws.onopen = () => { for (const m of s.outbox.splice(0)) { try { ws.send(m); } catch (e) {} } };
    ws.onmessage = (ev) => {
      const d = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      s.inbox.push(d);
      s.inboxBytes += Buffer.byteLength(d);
      dropOldest(s);
      const w = s.waiters.splice(0);
      for (const fn of w) { try { fn(); } catch (e) {} }
    };
    ws.onerror = () => {};
    ws.onclose = () => { s.closed = true; };
  } catch (e) { s.closed = true; }
  return s;
}

// 未活跃会话回收：长期不 poll 的会话（关页没调 close 的）按 TTL 摘除，防 sessions Map 无界增长。
const sessionSweeper = setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      sessions.delete(sid);
      try { s.ws && s.ws.close(); } catch (e) {}
    }
  }
}, SESSION_SWEEP_MS);
if (sessionSweeper.unref) sessionSweeper.unref();

function waitFor(s, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; s.waiters = s.waiters.filter((f) => f !== fn); resolve(); } }, ms);
    const fn = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    s.waiters.push(fn);
  });
}

async function proxy(req, res) {
  const headers = { ...req.headers };
  delete headers.host; delete headers['accept-encoding']; delete headers.connection;
  const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readBody(req);
  try {
    const r = await fetch(BACKEND_HTTP + req.url, { method: req.method, headers, body, redirect: 'manual' });
    const out = {};
    r.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection|keep-alive)$/i.test(k)) out[k] = v; });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) out['set-cookie'] = sc;
    res.writeHead(r.status, out);
    const ct = (r.headers.get('content-type') || '');
    if (ct.includes('text/html')) {
      let html = await r.text();
      if (!html.includes('/bridge/shim.js')) {
        const tag = '<script src="/bridge/shim.js"></script>';
        html = html.includes('</head>') ? html.replace('</head>', tag + '</head>') : tag + html;
      }
      res.end(html);
    } else res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('bridge upstream error: ' + e.message);
  }
}

async function handlePoll(req, res, url) {
  const sid = url.searchParams.get('sid') || ('s' + Math.random().toString(36).slice(2));
  const token = url.searchParams.get('token') || '';
  const s = ensureSession(sid, token);
  if (s.inbox.length === 0 && !s.closed) await waitFor(s, POLL_MS);
  if (s.closed && s.inbox.length === 0) { res.writeHead(502, { 'cache-control': 'no-store' }); res.end('backend gone'); return; }
  const msgs = s.inbox.splice(0);
  s.inboxBytes = 0;
  if (msgs.length === 0) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(msgs.join('\n') + '\n');
}

async function handleSend(req, res, url) {
  const sid = url.searchParams.get('sid') || '';
  const token = url.searchParams.get('token') || '';
  const body = (await readBody(req)).toString('utf8');
  if (sid) {
    const s = ensureSession(sid, token);
    if (s.ws && s.ws.readyState === 1) { try { s.ws.send(body); } catch (e) { s.outbox.push(body); } }
    else s.outbox.push(body);
  }
  res.writeHead(204); res.end();
}

async function handleClose(req, res, url) {
  const sid = url.searchParams.get('sid');
  const s = sessions.get(sid);
  if (s) { sessions.delete(sid); try { s.ws && s.ws.close(); } catch (e) {} }
  res.writeHead(204); res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/bridge/shim.js') { res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(SHIM); return; }
  if (p === '/bridge/poll') { await handlePoll(req, res, url); return; }
  if (p === '/bridge/send') { await handleSend(req, res, url); return; }
  if (p === '/bridge/close') { await handleClose(req, res, url); return; }
  await proxy(req, res);
});
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;
server.listen(PORT, '0.0.0.0', () => console.log('pi-web-ui bridge (polling) on ' + PORT + ' poll=' + POLL_MS + 'ms'));
