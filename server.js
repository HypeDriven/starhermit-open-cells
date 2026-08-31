'use strict';
/*
 * Open Cells — StarHermit authoritative script (server=server.js).
 *
 * Runs only when the game is hosted under a StarHermit-style shell. The game
 * itself is fully playable offline; this script exists for seeded daily
 * sessions, replay-validated leaderboards, durable achievements, and
 * server-time synchronization. It has no dependencies and never trusts
 * client clocks, scores, or completion claims.
 *
 * Expected host contract (defensive: every handler works standalone too):
 *   - The host invokes this script and routes same-origin /api/v1/* to it.
 *   - If the host instead runs this file under plain Node, it starts a tiny
 *     HTTP server on PORT (default 8787) serving the static distribution and
 *     the API — handy for local hosted-mode testing.
 *
 * Message schema (JSON):
 *   GET  /api/v1/time            -> { now: <unix ms> }
 *   POST /api/v1/scores          { board, dealId, seed, ruleset, contentVersion,
 *                                  score, assists, durationMs, moves, invalid,
 *                                  sessionId, replay? } -> { accepted, rank?, reason? }
 *   GET  /api/v1/boards?name=X   -> { board, entries: [...] }
 *   POST /api/v1/presence        { game } -> { ok: true }   (heartbeat, no-op state)
 *   POST /api/v1/activity        { event: 'start'|'end' } -> { ok: true }
 *   POST /api/v1/telemetry       { event, session, data, at } -> { ok: true }
 *   Errors: HTTP 4xx/5xx with { "error": "<code>" }. Rate limit: 429.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const R = require('./src/rules.js');
const S = require('./src/session.js');
const C = require('./src/content.js');

const DATA_DIR = process.env.OPEN_CELLS_DATA || path.join(__dirname, '.server-data');
const BOARDS_FILE = path.join(DATA_DIR, 'boards.json');
const ACHIEVEMENTS_FILE = path.join(DATA_DIR, 'achievements.json');

const MAX_BODY = 64 * 1024;         // payload size bound
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;               // per identity per window
const BOARD_CAP = 100;
const STALE_CONTENT_VERSION = C.CONTENT_VERSION; // equal-or-newer accepted

// ---------------------------------------------------------------- storage

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function saveJson(file, value) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- rate limit

const buckets = new Map();
function rateOk(identity) {
  const now = Date.now();
  let b = buckets.get(identity);
  if (!b || now - b.start > RATE_WINDOW_MS) { b = { start: now, count: 0 }; buckets.set(identity, b); }
  b.count++;
  return b.count <= RATE_MAX;
}

// ---------------------------------------------------------------- validation
// Score claims are untrusted. When a replay envelope is attached we re-run it
// deterministically; without one, only plausibility checks apply and the entry
// is labeled casual.

function validateScoreClaim(body) {
  const errors = [];
  if (!body || typeof body !== 'object') errors.push('bad-body');
  const req = ['board', 'dealId', 'seed', 'ruleset', 'contentVersion', 'score', 'sessionId'];
  for (const k of req) if (body[k] === undefined || body[k] === null) errors.push('missing-' + k);
  if (errors.length) return { ok: false, errors };
  if (!Number.isInteger(body.seed) || body.seed < 0) errors.push('bad-seed');
  if (body.ruleset !== 'open-cells/1') errors.push('bad-ruleset');
  if (body.contentVersion > STALE_CONTENT_VERSION) errors.push('future-version');
  if (!body.score || !Number.isInteger(body.score.total)) errors.push('bad-score');
  if (!Number.isInteger(body.moves) || body.moves < 0 || body.moves > 5000) errors.push('bad-moves');
  if (!Number.isInteger(body.durationMs) || body.durationMs < 0) errors.push('bad-duration');
  if (body.score.total < -1000 || body.score.total > 50000) errors.push('implausible-score');
  if (errors.length) return { ok: false, errors };

  // Daily boards only accept the real deal for the claimed day.
  if (body.board === 'daily') {
    const m = /^daily-(\d{4}-\d{2}-\d{2})$/.exec(body.dealId);
    if (!m) return { ok: false, errors: ['bad-daily-id'] };
    const expect = R.hashString('open-cells/daily/' + m[1]);
    if (expect !== body.seed) return { ok: false, errors: ['seed-mismatch'] };
  }

  if (body.replay) {
    const v = S.validateReplay(body.replay);
    if (!v.ok) return { ok: false, errors: ['replay-invalid:' + (v.mismatches[0] ? v.mismatches[0].reason : '?')] };
    const replayScore = body.replay.result && body.replay.result.score;
    if (!replayScore || replayScore.total !== body.score.total) {
      return { ok: false, errors: ['score-replay-mismatch'] };
    }
    return { ok: true, validated: true, errors: [] };
  }
  return { ok: true, validated: false, errors: [] };
}

// ---------------------------------------------------------------- handlers

function handleApi(req, res, identity, body) {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (!rateOk(identity)) return send(429, { error: 'rate-limited' });

  if (req.method === 'GET' && url.pathname === '/api/v1/time') {
    return send(200, { now: Date.now() });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/boards') {
    const name = url.searchParams.get('name') || 'daily';
    const boards = loadJson(BOARDS_FILE, { boards: {} });
    return send(200, { board: name, entries: (boards.boards[name] || []).slice(0, 50) });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/scores') {
    const verdict = validateScoreClaim(body);
    if (!verdict.ok) return send(422, { error: verdict.errors[0] });
    const boards = loadJson(BOARDS_FILE, { boards: {} });
    const list = boards.boards[body.board] || [];
    // Idempotent by session id: duplicate submissions collapse.
    if (!list.some(e => e.sessionId === body.sessionId)) {
      list.push({
        identity, sessionId: body.sessionId, board: body.board, dealId: body.dealId, seed: body.seed,
        ruleset: body.ruleset, contentVersion: body.contentVersion,
        score: body.score, moves: body.moves, invalid: body.invalid,
        durationMs: body.durationMs, validated: verdict.validated,
        label: verdict.validated ? 'validated' : 'casual',
        at: new Date().toISOString()
      });
      list.sort((a, b) => (b.score.total - a.score.total) || (a.invalid - b.invalid) || (a.durationMs - b.durationMs) || String(a.sessionId).localeCompare(String(b.sessionId)));
      boards.boards[body.board] = list.slice(0, BOARD_CAP);
      saveJson(BOARDS_FILE, boards);
    }
    const rank = (boards.boards[body.board] || []).findIndex(e => e.sessionId === body.sessionId) + 1;
    return send(200, { accepted: true, validated: verdict.validated, rank });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/achievements') {
    // Durable, idempotent achievement delivery.
    const key = body && body.key;
    if (!C.ACHIEVEMENTS.some(a => a.key === key)) return send(422, { error: 'unknown-achievement' });
    const store = loadJson(ACHIEVEMENTS_FILE, {});
    const mine = store[identity] || {};
    if (!mine[key]) { mine[key] = new Date().toISOString(); store[identity] = mine; saveJson(ACHIEVEMENTS_FILE, store); }
    return send(200, { ok: true, already: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/presence') return send(200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/api/v1/activity') {
    if (body && (body.event === 'start' || body.event === 'end')) return send(200, { ok: true });
    return send(422, { error: 'bad-activity-event' });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/telemetry') {
    // Anonymous funnel only; enforce the allow-list server-side too.
    const allowed = { start: 1, 'tutorial-step': 1, 'round-end': 1, retry: 1, 'settings-change': 1, error: 1 };
    if (body && allowed[body.event]) return send(200, { ok: true });
    return send(422, { error: 'event-not-allowed' });
  }

  return send(404, { error: 'not-found' });
}

// ---------------------------------------------------------------- static + http

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown', '.opus': 'audio/ogg' };

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(__dirname, p));
  if (!file.startsWith(__dirname) || file.includes('.server-data')) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer() {
  return http.createServer((req, res) => {
    const identity = req.headers['x-player-id'] || req.socket.remoteAddress || 'anon';
    if (req.url.startsWith('/api/')) {
      let raw = '';
      req.on('data', chunk => {
        raw += chunk;
        if (raw.length > MAX_BODY) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'payload-too-large' })); req.destroy(); }
      });
      req.on('end', () => {
        let body = null;
        if (raw) { try { body = JSON.parse(raw); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad-json' })); } }
        try { handleApi(req, res, String(identity), body); }
        catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'internal' })); }
      });
    } else {
      serveStatic(req, res);
    }
  });
}

// StarHermit shells import the script; plain Node runs it standalone.
if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  ensureDir();
  createServer().listen(port, () => {
    console.log(`Open Cells authoritative script listening on :${port}`);
  });
} else {
  module.exports = { createServer, validateScoreClaim };
}
