'use strict';
/* Open Cells — platform layer over the shared StarHermit SDK: launch token,
 * profile name, game:<slug> cloud-save round-trip, settings KV, controls, and
 * no network at all when standalone. Run: node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SDK = require('../src/starhermit-sdk.js');
const PLATFORM = path.join(__dirname, '../src/platform.js');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = 'h.' + b64u({ sub: 'user-123456', game_scope: 'oc-slug', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';
// SDK renewal timers must not keep the test process alive.
const unrefTimeout = (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; };

function fakeServer() {
  const calls = [], saves = {}, kv = {}, etags = {};
  let version = 0;
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url]);
    const r = (status, body) => new Response(body == null ? null : body, { status });
    if (url.includes('/cloud-saves/')) {
      // Conditional writes: the SDK sends If-Match / If-None-Match after a load;
      // a stale version gets 412 with the current etag, a write returns { etag }.
      const tail = decodeURIComponent(url.split('/cloud-saves/')[1]);
      const key = tail.replace(/\/info$/, '');
      const headers = new Headers(init.headers || {});
      if (tail.endsWith('/info')) return r(200, JSON.stringify(saves[key] ? { exists: true, etag: etags[key] } : { exists: false }));
      if (method === 'PUT') {
        const ifMatch = headers.get('If-Match'), ifNone = headers.get('If-None-Match');
        if ((ifMatch && ifMatch !== etags[key]) || (ifNone === '*' && saves[key])) return r(412, JSON.stringify({ etag: etags[key] || null }));
        saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        etags[key] = '"v' + (++version) + '"';
        return r(200, JSON.stringify({ etag: etags[key] }));
      }
      return saves[key] ? r(200, saves[key]) : r(404);
    }
    if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'u', nickname: 'Tess' }));
    if (url.endsWith('/settings') && method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return r(200, '{}'); }
    if (url.endsWith('/settings')) return r(200, JSON.stringify({ settings: kv }));
    if (url.endsWith('/controls')) return r(200, JSON.stringify({ actions: [{ action: 'hint', codes: ['KeyJ'] }] }));
    if (url.endsWith('/api/v1/time')) return r(200, JSON.stringify({ now: Date.now() + 60000 }));
    return r(404);
  };
  return { calls, saves, kv, etags, fetch, bump(key) { etags[key] = '"v' + (++version) + '"'; } };
}

// Load src/platform.js fresh into a fake browser global.
function loadPlatform(hash, srv, hostname) {
  const store = new Map();
  const win = {
    location: { hash, search: '', pathname: '/', hostname, protocol: 'https:', origin: 'https://' + hostname, href: 'https://' + hostname + '/' },
    history: { replaceState() {} },
    addEventListener() {},
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    fetch: srv.fetch,
  };
  win.StarHermit = SDK.create({ window: win, fetch: srv.fetch, setTimeout: unrefTimeout });
  global.self = win;
  delete require.cache[PLATFORM];
  require(PLATFORM);
  delete global.self;
  return win;
}

const tick = () => new Promise((r) => setTimeout(r, 15));

test('hosted: token, profile, cloud save game:<slug>, settings KV, controls', async () => {
  const srv = fakeServer();
  const win = loadPlatform('#game_token=' + token, srv, 'oc-slug.starhermit.com');
  const P = win.OCPlatform;
  assert.equal(P.apiAvailable(), true);
  assert.ok((await P.syncTime()) > 50000); // platform clock, signed in only
  assert.equal(P.clockSynced(), true);
  assert.equal(P.getIdentity().sub, 'user-123456');
  assert.equal(P.getIdentity().slug, 'oc-slug');
  await tick();
  assert.equal(P.getIdentity().name, 'Tess');

  const doc = P.emptySave();
  doc.totals.wins = 3;
  P.persistSave(doc);
  await P.flushCloudSave();
  assert.deepEqual(Object.keys(srv.saves), ['game:oc-slug']);
  const remote = await P.loadCloudSave();
  assert.equal(remote.save.totals.wins, 3);

  P.updateSettings({ muted: true, tutorialComplete: true });
  await tick();
  assert.equal(srv.kv.muted, true);
  assert.equal('tutorialComplete' in srv.kv, false); // progress flags are not preferences
  srv.kv.theme = 'night-felt';
  assert.equal((await P.loadPlatformSettings()).theme, 'night-felt');

  assert.deepEqual(await P.loadBindings({ hint: ['KeyH'], undo: ['KeyZ'] }), { hint: ['KeyJ'], undo: ['KeyZ'] });
  assert.ok(P.inviteLink().endsWith('/game-invite/user-123456/oc-slug'));
  assert.equal(P.canSignIn(), false);
});

test('sign-in is offered on a StarHermit UUID host without a token', () => {
  const srv = fakeServer();
  const win = loadPlatform('', srv, '0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com');
  assert.equal(win.OCPlatform.canSignIn(), true);
});

test('cloud-save conflict: a write that lost to another device re-reads the slot and hands it to the game', async () => {
  const srv = fakeServer();
  const win = loadPlatform('#game_token=' + token, srv, 'oc-slug.starhermit.com');
  const P = win.OCPlatform;
  const first = P.emptySave();
  first.totals.wins = 1;
  P.persistSave(first);
  await P.flushCloudSave();
  await P.loadCloudSave(); // writes are conditional on this version from now on
  // Another device saves a newer document.
  const other = P.emptySave();
  other.journey['journey-01'] = { stars: 3, bestScore: 900, bestMoves: 140, completedAt: '2026-10-01T00:00:00.000Z' };
  other.totals.wins = 5;
  srv.saves['game:oc-slug'] = Buffer.from(await win.StarHermit._zip('save.json', new TextEncoder().encode(JSON.stringify({ save: other, boards: { boards: {} } }))));
  srv.bump('game:oc-slug');
  const got = new Promise((resolve) => P.onSaveConflict(resolve));
  const mine = P.emptySave();
  mine.totals.wins = 2;
  mine.lessons['learn-cells'] = { completedAt: '2026-10-02T00:00:00.000Z' };
  P.persistSave(mine);
  await P.flushCloudSave();
  const remote = await got;
  assert.equal(remote.save.totals.wins, 5);
  const merged = P.mergeSaves(remote.save, mine);
  assert.equal(merged.totals.wins, 5);
  assert.equal(merged.journey['journey-01'].stars, 3);
  assert.ok(merged.lessons['learn-cells']);
  P.persistSave(merged);
  await P.flushCloudSave();
  const back = await P.loadCloudSave();
  assert.equal(back.save.totals.wins, 5);
  assert.ok(back.save.lessons['learn-cells']);
});

test('mergeSaves keeps the better record of each and this device\'s in-progress deal', () => {
  const srv = fakeServer();
  const P = loadPlatform('', srv, 'example.org').OCPlatform;
  const a = P.emptySave(), b = P.emptySave();
  a.journey.j1 = { stars: 2, bestScore: 500, bestMoves: 150, completedAt: '2026-10-03' };
  b.journey.j1 = { stars: 1, bestScore: 700, bestMoves: 160, completedAt: '2026-10-01' };
  a.dailies['2026-10-05'] = { score: 10, won: true }; b.dailies['2026-10-05'] = { score: 30, won: true };
  a.dailyStreak = { count: 4, lastDate: '2026-10-05' }; b.dailyStreak = { count: 2, lastDate: '2026-10-04' };
  a.achievements.x = '2026-10-02'; b.achievements.y = '2026-10-03';
  a.totals = { foundations: 100, wins: 1, played: 9 }; b.totals = { foundations: 80, wins: 3, played: 4 };
  a.lastSnapshot = { config: { dealId: 'remote' } }; b.lastSnapshot = { config: { dealId: 'local' } };
  const m = P.mergeSaves(a, b);
  assert.deepEqual(m.journey.j1, { stars: 2, bestScore: 700, bestMoves: 150, completedAt: '2026-10-01' });
  assert.equal(m.dailies['2026-10-05'].score, 30);
  assert.deepEqual(m.dailyStreak, { count: 4, lastDate: '2026-10-05' });
  assert.deepEqual(Object.keys(m.achievements).sort(), ['x', 'y']);
  assert.deepEqual(m.totals, { foundations: 100, wins: 3, played: 9 });
  assert.equal(m.lastSnapshot.config.dealId, 'local');
  b.lastSnapshot = null;
  assert.equal(P.mergeSaves(a, b).lastSnapshot.config.dealId, 'remote');
});

test('standalone: no token means no fetch at all', async () => {
  const srv = fakeServer();
  const win = loadPlatform('', srv, 'example.org');
  const P = win.OCPlatform;
  assert.equal(P.apiAvailable(), false);
  assert.equal(P.getIdentity().name, null);
  P.persistSave(P.emptySave());
  await P.flushCloudSave();
  assert.equal(await P.loadCloudSave(), null);
  P.updateSettings({ muted: true });
  assert.equal(await P.loadPlatformSettings(), null);
  assert.deepEqual(await P.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });
  assert.equal(await P.getHostedLeaderboard(), null);
  assert.equal(P.inviteLink(), null);
  assert.equal(P.canSignIn(), false);
  await tick();
  assert.equal(srv.calls.length, 0);
});

test('standalone on localhost: time, scores, boards make zero requests', async () => {
  const srv = fakeServer();
  const win = loadPlatform('', srv, 'localhost');
  const P = win.OCPlatform;
  assert.equal(await P.syncTime(), 0);
  assert.equal(P.clockSynced(), false);
  P.submitScore({ board: 'daily:2026-10-04', score: { total: 10 }, invalid: 0, durationMs: 1, sessionId: 's1' });
  assert.equal(P.getBoard('daily:2026-10-04').length, 1);
  for (const gone of ['apiFetch', 'devApiAvailable', 'telemetry']) assert.equal(P[gone], undefined, gone);
  await tick();
  assert.equal(srv.calls.length, 0);
});
