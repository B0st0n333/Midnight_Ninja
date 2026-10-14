'use strict';
// Storage for player accounts.
//  - If the environment variable DATABASE_URL is set, accounts live in that Postgres database
//    (use a free Neon database; the free disk on Render is erased on every restart).
//  - Otherwise accounts go into a local SQLite file. Good for trying things on your own computer,
//    but on Render free that file disappears when the server restarts.

const path = require('path');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     uname TEXT PRIMARY KEY,
     display TEXT NOT NULL,
     salt TEXT NOT NULL,
     hash TEXT NOT NULL,
     created BIGINT NOT NULL,
     wins INTEGER NOT NULL DEFAULT 0,
     losses INTEGER NOT NULL DEFAULT 0,
     kills INTEGER NOT NULL DEFAULT 0,
     best_survive INTEGER NOT NULL DEFAULT 0,
     cleared TEXT NOT NULL DEFAULT '[]'
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     uname TEXT NOT NULL,
     created BIGINT NOT NULL
   )`,
];

function pgBackend(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    max: 5,
    ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false },
  });
  pool.on('error', e => console.error('database connection error:', e.message));
  return {
    name: 'postgres',
    async query(sql, params = []) {
      const r = await pool.query(sql, params);
      return { rows: r.rows, count: r.rowCount };
    },
  };
}

function sqliteBackend(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  return {
    name: 'sqlite',
    async query(sql, params = []) {
      const q = sql.replace(/\$(\d+)/g, '?$1'); // same queries as Postgres: $1 becomes ?1
      const st = db.prepare(q);
      if (/^\s*select/i.test(q) || /\breturning\b/i.test(q)) {
        const rows = st.all(...params);
        return { rows, count: rows.length };
      }
      const r = st.run(...params);
      return { rows: [], count: Number(r.changes) };
    },
  };
}

const be = process.env.DATABASE_URL
  ? pgBackend(process.env.DATABASE_URL)
  : sqliteBackend(process.env.SQLITE_FILE || path.join(__dirname, 'data.db'));

const num = v => Number(v) || 0;

function toUser(r) {
  if (!r) return null;
  let cleared = [];
  try { cleared = JSON.parse(r.cleared || '[]'); } catch (e) { /* ignore */ }
  return {
    uname: r.uname, display: r.display, salt: r.salt, hash: r.hash,
    created: num(r.created), wins: num(r.wins), losses: num(r.losses),
    kills: num(r.kills), bestSurvive: num(r.best_survive), cleared,
  };
}

async function init() {
  for (const sql of SCHEMA) await be.query(sql);
  await be.query('DELETE FROM sessions WHERE created < $1', [Date.now() - 100 * 24 * 3600 * 1000]);
}

async function getUser(uname) {
  const r = await be.query('SELECT * FROM users WHERE uname = $1', [uname]);
  return toUser(r.rows[0]);
}

// returns false when the name is already taken
async function createUser(u) {
  const r = await be.query(
    'INSERT INTO users (uname, display, salt, hash, created) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (uname) DO NOTHING',
    [u.uname, u.display, u.salt, u.hash, Date.now()]
  );
  return r.count === 1;
}

async function createSession(tokenHash, uname) {
  await be.query('INSERT INTO sessions (token_hash, uname, created) VALUES ($1, $2, $3)', [tokenHash, uname, Date.now()]);
}

async function getSessionUser(tokenHash, maxAgeMs) {
  const r = await be.query(
    'SELECT u.* FROM sessions s JOIN users u ON u.uname = s.uname WHERE s.token_hash = $1 AND s.created > $2',
    [tokenHash, Date.now() - maxAgeMs]
  );
  return toUser(r.rows[0]);
}

async function deleteSession(tokenHash) {
  await be.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

// progress is merged, never reduced: cleared levels only get added, best survival only goes up
async function saveProgress(uname, p) {
  const u = await getUser(uname);
  if (!u) return null;
  const cleared = new Set(u.cleared);
  if (Number.isInteger(p.clear)) cleared.add(p.clear);
  const best = Math.max(u.bestSurvive, p.survive || 0);
  const kills = u.kills + (p.kills || 0);
  await be.query('UPDATE users SET kills = $1, best_survive = $2, cleared = $3 WHERE uname = $4',
    [kills, best, JSON.stringify([...cleared].sort((a, b) => a - b)), uname]);
  return getUser(uname);
}

async function addPvp(winner, loser) {
  await be.query('UPDATE users SET wins = wins + 1 WHERE uname = $1', [winner]);
  await be.query('UPDATE users SET losses = losses + 1 WHERE uname = $1', [loser]);
}

async function leaderboard(limit) {
  const r = await be.query(
    'SELECT display, wins, losses FROM users WHERE wins > 0 ORDER BY wins DESC, losses ASC, created ASC LIMIT $1',
    [limit || 10]
  );
  return r.rows.map(x => ({ name: x.display, wins: num(x.wins), losses: num(x.losses) }));
}

async function countUsers() {
  const r = await be.query('SELECT COUNT(*) AS n FROM users');
  return num(r.rows[0] && r.rows[0].n);
}

module.exports = {
  init, getUser, createUser, createSession, getSessionUser, deleteSession,
  saveProgress, addPvp, leaderboard, countUsers, backend: be.name,
};
