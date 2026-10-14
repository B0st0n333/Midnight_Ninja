'use strict';
// Midnight Ninja online server: serves the game from ./public, pairs players over WebSocket,
// and keeps player accounts (usernames, saved progress, verified duel results).
//
// Environment variables (all optional):
//   PORT             port to listen on (default 3000; hosting services set this for you)
//   DATABASE_URL     Postgres connection string (free Neon database). Without it, accounts are kept
//                    in a local file that Render erases on restart, so set it for real use.
//   ADMIN_KEY        secret for the owner stats page: /stats?key=YOUR_KEY (page is off when unset)
//   ALLOWED_ORIGINS  comma separated site addresses allowed to connect, e.g. https://mysite.com
//                    (only needed if the game page lives on a different domain than this server)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
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

// ---------------------------------------------------------------- accounts
let db = null;
let accountsOn = false;
try {
  db = require('./db');
  db.init()
    .then(() => {
      accountsOn = true;
      console.log('Accounts ready (' + db.backend + ')');
      if (db.backend === 'sqlite') {
        console.log('NOTE: no DATABASE_URL set, so accounts are saved to a local file. On Render free that file is erased when the server restarts.');
      }
    })
    .catch(e => console.error('Accounts are OFF, database problem:', e.message));
} catch (e) {
  console.error('Accounts are OFF:', e.message);
}

const scrypt = util.promisify(crypto.scrypt);
const SESSION_MS = 90 * 24 * 3600 * 1000;
const CLEARABLE = new Set([0, 1, 2, 3, 4, 5, 7, 8]); // level numbers that can be marked as cleared
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

async function hashPw(pw, saltHex) {
  return (await scrypt(pw, Buffer.from(saltHex, 'hex'), 64)).toString('hex');
}
async function checkPw(pw, user) {
  const got = Buffer.from(await hashPw(pw, user.salt), 'hex');
  const want = Buffer.from(user.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

async function userFromToken(token) {
  if (!accountsOn || typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
  try { return await db.getSessionUser(sha(token), SESSION_MS); } catch (e) { return null; }
}

const publicUser = u => ({
  name: u.display, wins: u.wins, losses: u.losses, kills: u.kills,
  bestSurvive: u.bestSurvive, cleared: u.cleared,
});

// simple in-memory rate limiter: allow `max` events per `windowMs` for a key
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(now);
  buckets.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    if (!arr.length || now - arr[arr.length - 1] > 3600 * 1000) buckets.delete(k);
  }
}, 10 * 60 * 1000);

function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  return (f ? String(f).split(',')[0].trim() : req.socket.remoteAddress) || 'x';
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 4096) { reject(new Error('too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const bearer = req => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
};

async function newSession(uname) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.createSession(sha(token), uname);
  return token;
}

async function handleApi(req, res, url) {
  // cross-site use is only allowed for origins listed in ALLOWED_ORIGINS
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const route = url.pathname;
  if (route === '/api/ping') return sendJson(res, 200, { accounts: accountsOn });
  if (!accountsOn) return sendJson(res, 503, { error: 'Accounts are not available right now.' });
  const ip = clientIp(req);

  try {
    if (route === '/api/register' && req.method === 'POST') {
      if (limited('reg:' + ip, 8, 3600 * 1000)) return sendJson(res, 429, { error: 'Too many tries. Please wait a while.' });
      const b = await readBody(req);
      const name = String(b.username || '');
      const pw = String(b.password || '');
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return sendJson(res, 400, { error: 'Username must be 3 to 16 letters, numbers or underscores.' });
      if (pw.length < 8 || pw.length > 64) return sendJson(res, 400, { error: 'Password must be 8 to 64 characters.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const ok = await db.createUser({ uname: name.toLowerCase(), display: name, salt, hash: await hashPw(pw, salt) });
      if (!ok) return sendJson(res, 409, { error: 'That username is taken.' });
      const token = await newSession(name.toLowerCase());
      const user = await db.getUser(name.toLowerCase());
      return sendJson(res, 200, { token, user: publicUser(user) });
    }

    if (route === '/api/login' && req.method === 'POST') {
      if (limited('login:' + ip, 20, 10 * 60 * 1000)) return sendJson(res, 429, { error: 'Too many tries. Please wait a few minutes.' });
      const b = await readBody(req);
      const uname = String(b.username || '').toLowerCase().slice(0, 16);
      const pw = String(b.password || '').slice(0, 64);
      const user = uname ? await db.getUser(uname) : null;
      let good = false;
      if (user) good = await checkPw(pw, user);
      else await hashPw(pw, DUMMY_SALT); // take the same time whether or not the name exists
      if (!good) {
        if (limited('wrong:' + uname, 8, 10 * 60 * 1000)) return sendJson(res, 429, { error: 'Too many wrong passwords for that name. Wait a few minutes.' });
        return sendJson(res, 401, { error: 'Wrong username or password.' });
      }
      const token = await newSession(uname);
      return sendJson(res, 200, { token, user: publicUser(user) });
    }

    if (route === '/api/logout' && req.method === 'POST') {
      const t = bearer(req);
      if (t) await db.deleteSession(sha(t));
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/me' && req.method === 'GET') {
      const user = await userFromToken(bearer(req));
      if (!user) return sendJson(res, 401, { error: 'Please log in.' });
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (route === '/api/progress' && req.method === 'POST') {
      const user = await userFromToken(bearer(req));
      if (!user) return sendJson(res, 401, { error: 'Please log in.' });
      if (limited('prog:' + user.uname, 1, 2000)) return sendJson(res, 429, { error: 'Slow down.' });
      const b = await readBody(req);
      const patch = {};
      if (b.clear !== undefined) {
        if (!Number.isInteger(b.clear) || !CLEARABLE.has(b.clear)) return sendJson(res, 400, { error: 'bad level' });
        patch.clear = b.clear;
      }
      if (b.survive !== undefined) {
        if (!Number.isInteger(b.survive) || b.survive < 0 || b.survive > 180) return sendJson(res, 400, { error: 'bad time' });
        patch.survive = b.survive;
      }
      if (b.kills !== undefined) {
        if (!Number.isInteger(b.kills) || b.kills < 0 || b.kills > 200) return sendJson(res, 400, { error: 'bad kills' });
        patch.kills = b.kills;
      }
      const saved = await db.saveProgress(user.uname, patch);
      return sendJson(res, 200, { user: publicUser(saved) });
    }

    if (route === '/api/leaderboard' && req.method === 'GET') {
      return sendJson(res, 200, { top: await db.leaderboard(10) });
    }
  } catch (e) {
    if (e && e.message === 'too big') return sendJson(res, 413, { error: 'Request too large.' });
    if (e instanceof SyntaxError) return sendJson(res, 400, { error: 'Bad request.' });
    console.error('api error:', e && e.message);
    return sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
  }
  return sendJson(res, 404, { error: 'Not found.' });
}

// ---------------------------------------------------------------- web pages
const rooms = new Map(); // room code -> array of up to 2 sockets
let queue = [];          // sockets waiting for a quick match
let matches = 0;
let recordedDuels = 0;
const startedAt = Date.now();

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end('bad request'); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('bad request'); }

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (pathname.startsWith('/api/')) return void handleApi(req, res, url);

  if (pathname === '/health') { res.writeHead(200); return res.end('ok'); }

  if (pathname === '/stats') {
    if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(403); return res.end('forbidden'); }
    const out = {
      playersOnline: wss.clients.size,
      rooms: rooms.size,
      waitingForQuickMatch: queue.length,
      matchesStarted: matches,
      duelsRecorded: recordedDuels,
      accountsEnabled: accountsOn,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
    const done = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out, null, 2)); };
    if (!accountsOn) return done();
    out.storage = db.backend;
    return db.countUsers().then(n => { out.accounts = n; done(); }).catch(done);
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

// ---------------------------------------------------------------- game rooms
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

// a duel counts for the leaderboard only when BOTH logged-in players report the same round
// with opposite results (one win, one loss) within 20 seconds, and never more than 10 times
// per day for the same two players
const pairCount = new Map();
async function recordDuel(ws, round, outcome) {
  const arr = rooms.get(ws.room);
  if (!arr || !ws.user) return;
  arr.claims = arr.claims || {};
  arr.recorded = arr.recorded || new Set();
  const mine = { round, outcome, uname: ws.user.uname, at: Date.now() };
  arr.claims[ws.slot] = mine;
  const other = arr.find(w => w !== ws);
  if (!other || !other.user) return;
  const theirs = arr.claims[other.slot];
  if (!theirs || theirs.round !== round || theirs.outcome === outcome) return;
  if (Math.abs(mine.at - theirs.at) > 20000) return;
  if (mine.uname === theirs.uname || arr.recorded.has(round)) return;
  const winner = outcome === 'win' ? mine : theirs;
  const loser = outcome === 'win' ? theirs : mine;
  const key = [winner.uname, loser.uname].sort().join('|') + '|' + new Date().toISOString().slice(0, 10);
  const n = pairCount.get(key) || 0;
  if (n >= 10) return;
  pairCount.set(key, n + 1);
  arr.recorded.add(round);
  await db.addPvp(winner.uname, loser.uname);
  recordedDuels++;
  send(ws, { t: 'recorded' });
  send(other, { t: 'recorded' });
}
setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  for (const k of pairCount.keys()) if (!k.endsWith('|' + today)) pairCount.delete(k);
}, 3600 * 1000);

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.room = null;
  ws.slot = null;
  ws.user = null;
  ws.tokens = 120;
  ws.lastMsg = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async data => {
    // simple rate limit: about 80 messages a second, bursts up to 120
    const now = Date.now();
    ws.tokens = Math.min(120, ws.tokens + (now - ws.lastMsg) / 1000 * 80);
    ws.lastMsg = now;
    if (ws.tokens < 1) return;
    ws.tokens--;

    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    try {
      if (m.t === 'join' || m.t === 'quick') {
        ws.user = await userFromToken(m.token); // null for guests
        if (ws.readyState !== 1) return;
        if (m.t === 'join') {
          const code = String(m.code || '').toLowerCase();
          if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(code)) return send(ws, { t: 'bad' });
          joinRoom(ws, code);
        } else {
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
        }
      } else if (m.t === 'p') {
        if (!ws.room) return;
        const d = m.d;
        if (!d || typeof d !== 'object' || Array.isArray(d)) return;
        const out = Object.assign({}, d);
        if (ws.user) out.nm = ws.user.display; else delete out.nm; // the server decides the name shown
        const s = JSON.stringify(out);
        if (s.length > 4096) return;
        const other = (rooms.get(ws.room) || []).find(w => w !== ws);
        if (other && other.readyState === 1) other.send('{"t":"p","d":' + s + '}');
      } else if (m.t === 'result') {
        const round = Math.trunc(Number(m.round));
        if (!ws.room || !(round >= 1 && round <= 999)) return;
        if (m.outcome !== 'win' && m.outcome !== 'loss') return;
        await recordDuel(ws, round, m.outcome);
      } else if (m.t === 'leave') {
        leaveRoom(ws);
      }
    } catch (e) {
      console.error('socket error:', e && e.message);
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
