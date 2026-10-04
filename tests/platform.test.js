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
  const calls = [], saves = {}, kv = {};
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url]);
    const r = (status, body) => new Response(body == null ? null : body, { status });
    if (url.includes('/cloud-saves/')) {
      const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (method === 'PUT') { saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return r(200, '{}'); }
      return saves[key] ? r(200, saves[key]) : r(404);
    }
    if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'u', nickname: 'Tess' }));
    if (url.endsWith('/settings') && method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return r(200, '{}'); }
    if (url.endsWith('/settings')) return r(200, JSON.stringify({ settings: kv }));
    if (url.endsWith('/controls')) return r(200, JSON.stringify({ actions: [{ action: 'hint', codes: ['KeyJ'] }] }));
    if (url.endsWith('/api/v1/time')) return r(200, JSON.stringify({ now: Date.now() + 60000 }));
    return r(404);
  };
  return { calls, saves, kv, fetch };
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
