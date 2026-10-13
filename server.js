'use strict';
// Midnight Ninja online server: serves the game from ./public and pairs players over WebSocket.
//
// Environment variables (all optional):
//   PORT             port to listen on (default 3000; hosting services set this for you)
//   ADMIN_KEY        secret for the owner stats page: /stats?key=YOUR_KEY (page is off when unset)
//   ALLOWED_ORIGINS  comma separated site addresses allowed to connect, e.g. https://mysite.com
//                    (default: any site; only needed if the game page lives on a different domain)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const PUB = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

const rooms = new Map(); // room code -> array of up to 2 sockets
let queue = [];          // sockets waiting for a quick match
let matches = 0;
const startedAt = Date.now();

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end('bad request'); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('bad request'); }

  if (pathname === '/health') { res.writeHead(200); return res.end('ok'); }

  if (pathname === '/stats') {
    if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(403); return res.end('forbidden'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      playersOnline: wss.clients.size,
      rooms: rooms.size,
      waitingForQuickMatch: queue.length,
      matchesStarted: matches,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }, null, 2));
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(PUB, rel);
  if (full !== PUB && !full.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({
  server,
  maxPayload: 8 * 1024,
  verifyClient: (info, done) => {
    if (!ORIGINS.length) return done(true);
    done(ORIGINS.includes(info.origin), 403, 'origin not allowed');
  },
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function leaveRoom(ws) {
  queue = queue.filter(w => w !== ws);
  const code = ws.room;
  if (!code) return;
  ws.room = null;
  ws.slot = null;
  const arr = (rooms.get(code) || []).filter(w => w !== ws);
  if (arr.length) {
    rooms.set(code, arr);
    arr.forEach(w => send(w, { t: 'left' }));
  } else {
    rooms.delete(code);
  }
}

function joinRoom(ws, code) {
  leaveRoom(ws);
  const arr = rooms.get(code) || [];
  if (arr.length >= 2) return send(ws, { t: 'full' });
  const taken = new Set(arr.map(w => w.slot));
  ws.slot = taken.has('a') ? 'b' : 'a';
  ws.room = code;
  arr.push(ws);
  rooms.set(code, arr);
  send(ws, { t: 'joined', peer: ws.slot, code, count: arr.length });
  if (arr.length === 2) {
    matches++;
    send(arr[0], { t: 'peer' });
  }
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.room = null;
  ws.slot = null;
  ws.tokens = 120;
  ws.lastMsg = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', data => {
    // simple rate limit: about 80 messages a second, bursts up to 120
    const now = Date.now();
    ws.tokens = Math.min(120, ws.tokens + (now - ws.lastMsg) / 1000 * 80);
    ws.lastMsg = now;
    if (ws.tokens < 1) return;
    ws.tokens--;

    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join') {
      const code = String(m.code || '').toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(code)) return send(ws, { t: 'bad' });
      joinRoom(ws, code);
    } else if (m.t === 'quick') {
      leaveRoom(ws);
      queue = queue.filter(w => w.readyState === 1 && w !== ws);
      const partner = queue.shift();
      if (partner) {
        const code = 'q' + crypto.randomBytes(3).toString('hex');
        joinRoom(partner, code);
        joinRoom(ws, code);
      } else {
        queue.push(ws);
        send(ws, { t: 'waiting' });
      }
    } else if (m.t === 'p') {
      if (!ws.room) return;
      const d = m.d;
      if (!d || typeof d !== 'object' || Array.isArray(d)) return;
      const s = JSON.stringify(d);
      if (s.length > 4096) return;
      const other = (rooms.get(ws.room) || []).find(w => w !== ws);
      if (other && other.readyState === 1) other.send('{"t":"p","d":' + s + '}');
    } else if (m.t === 'leave') {
      leaveRoom(ws);
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

// drop connections that stopped answering
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('Midnight Ninja server listening on port ' + PORT));
