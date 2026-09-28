/*
 * Open Cells — platform layer.
 * StarHermit launch-token handling (fragment #game_token, read once + stripped,
 * 45-min re-mint), profile nickname, cloud save mirror (zip+base64 into the
 * platform slot, localStorage stays the offline cache), versioned checksummed
 * save document, per-game settings, local boards + read-only hosted
 * leaderboard, and a token-aware REST adapter that degrades gracefully to
 * fully offline play. Time sync, validated score submission, presence,
 * activity and telemetry only run against the game's own local dev server
 * (localhost), never against the StarHermit host. Browser only (uses
 * localStorage/fetch). Exposes window.OCPlatform.
 */
(function (global) {
  'use strict';

  var SAVE_KEY = 'open-cells/save/v1';
  var SETTINGS_KEY = 'open-cells/settings/v1';
  var BOARD_KEY = 'open-cells/boards/v1';
  var SAVE_VERSION = 1;
  var CLOUD_KIND = 'open-cells/cloud/v1';
  var SAVE_ENTRY_NAME = 'save.json';
  var CLOUD_DEBOUNCE_MS = 2000;
  var TOKEN_REFRESH_MS = 45 * 60 * 1000;   // tokens live 60 min; renew early
  var TOKEN_RETRY_MS = 60 * 1000;

  var DEFAULT_SETTINGS = {
    theme: 'brass-slate',
    quality: 'auto',            // legacy tier; superseded by `graphics`
    graphics: null,             // { preset, render_scale, adaptive, show_fps, <category> } (see src/gfx.js)
    reducedMotion: false,
    highContrast: false,
    largerText: false,
    leftHanded: false,
    holdToDrag: false,          // hold vs toggle selection
    haptics: true,
    colorPalette: 'standard',   // 'standard' | 'deuteranopia' | 'tritanopia'
    volume: { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.7 },
    muted: false,
    keybindings: {              // desktop action bindings; player-overridable
      undo: 'KeyZ', hint: 'KeyH', auto: 'KeyA', pause: 'Escape', restart: 'KeyR', cameraReset: 'Digit0'
    },
    tutorialComplete: false,
    telemetryConsent: false
  };

  // ---------------------------------------------------------------- launch token
  // The platform hands the game its launch token in the URL fragment:
  //   #game_token=<jwt>[&session_id=<guid>]
  // Read once, then strip it from the address bar. The JWT payload is
  // base64url-decoded (never verified): sub = user id, game_scope = the game
  // slug. Query-param fallbacks exist ONLY for the local dev server, which
  // cannot mint URL fragments.

  function b64urlJson(seg) {
    if (!seg) return null;
    try {
      var b64 = String(seg).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      return JSON.parse(atob(b64));
    } catch (e) { return null; }
  }

  function isLocalDevHost(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0'
      || hostname === '::1' || /\.localhost$/i.test(String(hostname));
  }

  function stripLaunchFragment() {
    try {
      var loc = global.location;
      var parts = String(loc.hash || '').replace(/^#/, '').split('&').filter(function (kv) {
        return kv && !/^game_token=/.test(kv) && !/^session_id=/.test(kv);
      });
      var clean = parts.length ? '#' + parts.join('&') : '';
      global.history.replaceState(null, '', loc.pathname + loc.search + clean);
    } catch (e) { /* history blocked (iframe/file): token still works */ }
  }

  function readLaunchToken() {
    var out = { token: null, sessionId: null, sub: null, slug: null };
    var loc = global.location;
    if (!loc) return out;
    var hash = String(loc.hash || '');
    var m = /(?:^|[#&])game_token=([^&]+)/.exec(hash);
    if (m) {
      try { out.token = decodeURIComponent(m[1]); } catch (e) { out.token = m[1]; }
      var sid = /[#&]session_id=([^&]+)/.exec(hash);
      if (sid) { try { out.sessionId = decodeURIComponent(sid[1]); } catch (e) {} }
      stripLaunchFragment();
    } else if (loc.search) {
      var q = null;
      try { q = new URLSearchParams(loc.search); } catch (e) { q = null; }
      if (q && isLocalDevHost(loc.hostname)) {
        var qt = q.get('game_token') || q.get('launch_token') || q.get('launch') || q.get('token');
        if (qt) out.token = qt;
        var qs = q.get('session_id');
        if (qs) out.sessionId = qs;
      }
    }
    if (out.token) {
      var payload = b64urlJson(String(out.token).split('.')[1]);
      if (payload) {
        out.sub = payload.sub || null;
        out.slug = payload.game_scope || null;
      }
    }
    return out;
  }

  var launch = readLaunchToken();
  var hosted = !!launch.token;   // hosted mode iff a launch token was read

  // ---------------------------------------------------------------- zip helpers
  // Minimal ZIP writer/reader (stored entries only, no compression).
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(name, dataBytes) {
    const enc = new TextEncoder();
    const nameB = enc.encode(name);
    const crc = crc32(dataBytes);
    const out = [];
    const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
    const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(crc); u32(dataBytes.length); u32(dataBytes.length);
    u16(nameB.length); u16(0);
    const local = out.length;
    const head = new Uint8Array(out);
    const cd = [];
    const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
    const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
    c32(crc); c32(dataBytes.length); c32(dataBytes.length);
    c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
    const cdHead = new Uint8Array(cd);
    const cdOff = head.length + nameB.length + dataBytes.length;
    const parts = [head, nameB, dataBytes, cdHead, nameB];
    const eocd = [];
    const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
    e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
    e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
    parts.push(new Uint8Array(eocd));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
  }
  function unzipFirstEntry(zipBytes) {
    // Stored single-entry reader: scan local headers for compression 0.
    const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    let off = 0;
    while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
      const method = dv.getUint16(off + 8, true);
      const size = dv.getUint32(off + 18, true);
      const nameLen = dv.getUint16(off + 26, true);
      const extraLen = dv.getUint16(off + 28, true);
      const dataOff = off + 30 + nameLen + extraLen;
      if (method !== 0) throw new Error('unsupported zip entry');
      return zipBytes.slice(dataOff, dataOff + size);
    }
    throw new Error('bad zip');
  }
  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const s = atob(b64);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  // ---------------------------------------------------------------- storage

  function readJson(key, fallback) {
    try {
      var raw = global.localStorage && global.localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function writeJson(key, value) {
    try {
      global.localStorage && global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  }

  // Small stable checksum (FNV-1a) for save integrity.
  function checksum(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ---------------------------------------------------------------- settings

  var settings = Object.assign({}, DEFAULT_SETTINGS, readJson(SETTINGS_KEY, {}));
  settings.volume = Object.assign({}, DEFAULT_SETTINGS.volume, settings.volume || {});
  settings.keybindings = Object.assign({}, DEFAULT_SETTINGS.keybindings, settings.keybindings || {});

  function getSettings() { return JSON.parse(JSON.stringify(settings)); }

  function updateSettings(patch) {
    var before = JSON.stringify(settings);
    if (patch.volume) settings.volume = Object.assign({}, settings.volume, patch.volume);
    if (patch.keybindings) settings.keybindings = Object.assign({}, settings.keybindings, patch.keybindings);
    var p = Object.assign({}, patch); delete p.volume; delete p.keybindings;
    settings = Object.assign({}, settings, p);
    writeJson(SETTINGS_KEY, settings);
    if (JSON.stringify(settings) !== before) telemetry('settings-change', {});
    return getSettings();
  }

  // ---------------------------------------------------------------- save doc
  // Versioned, checksummed progression document. localStorage is the offline
  // cache; the StarHermit cloud-saves slot mirrors it when hosted.

  function emptySave() {
    return {
      version: SAVE_VERSION,
      journey: {},            // stageId -> { stars, bestScore, bestMoves, completedAt }
      lessons: {},            // lessonId -> { completedAt }
      dailies: {},            // iso date -> { score, won, completedAt }
      dailyStreak: { count: 0, lastDate: null },
      achievements: {},       // key -> unlockedAt (ISO)
      totals: { foundations: 0, wins: 0, played: 0 },
      lastSnapshot: null,     // serialized resumable session
      updatedAt: null
    };
  }

  function loadSave() {
    var doc = readJson(SAVE_KEY, null);
    if (!doc) return { doc: emptySave(), conflict: null };
    if (typeof doc.payload !== 'string' || doc.checksum !== checksum(doc.payload)) {
      // Corrupt — preserve the bytes and start clean rather than discarding.
      writeJson(SAVE_KEY + '.corrupt.' + Date.now(), doc);
      return { doc: emptySave(), conflict: 'checksum-mismatch' };
    }
    try {
      var payload = JSON.parse(doc.payload);
      if (payload.version !== SAVE_VERSION) payload = migrateSave(payload);
      return { doc: Object.assign(emptySave(), payload), conflict: null };
    } catch (e) {
      return { doc: emptySave(), conflict: 'parse-error' };
    }
  }

  // Save migrations run in order; keep them forever (spec: migration tests).
  var MIGRATIONS = {
    // Example shape for future versions:
    // 2: function (doc) { doc.version = 2; return doc; }
  };

  function migrateSave(doc) {
    var v = doc.version;
    while (v < SAVE_VERSION) {
      var step = MIGRATIONS[v + 1];
      if (!step) break;
      doc = step(doc);
      v = doc.version;
    }
    return doc;
  }

  // Validate/migrate a save document received from the cloud slot.
  function adoptSave(doc) {
    if (!doc || typeof doc !== 'object') return emptySave();
    if (doc.version !== SAVE_VERSION) doc = migrateSave(doc);
    return Object.assign(emptySave(), doc);
  }

  function persistSave(doc) {
    doc.updatedAt = new Date().toISOString();
    var payload = JSON.stringify(doc);
    var ok = writeJson(SAVE_KEY, { checksum: checksum(payload), payload: payload });
    scheduleCloudSave(doc);
    return ok;
  }

  // ---------------------------------------------------------------- boards
  // Local leaderboards (personal bests, cloud-mirrored with the save doc).
  // Every entry carries ruleset, content version, seed, assists, duration.
  // On-platform there is no client score submission: platform leaderboards
  // are script-owned; the hosted game reads them read-only.

  function loadBoards() { return readJson(BOARD_KEY, { boards: {} }); }

  function sortBoardEntries(list) {
    list.sort(function (a, b) {
      if (b.score.total !== a.score.total) return b.score.total - a.score.total;
      if (a.invalid !== b.invalid) return a.invalid - b.invalid;
      if (a.durationMs !== b.durationMs) return a.durationMs - b.durationMs;
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });
    return list;
  }

  function submitScore(entry) {
    // entry: { board, dealId, seed, ruleset, contentVersion, score, assists,
    //          durationMs, moves, invalid, sessionId, at }
    var data = loadBoards();
    var list = data.boards[entry.board] || [];
    // Local copies drop the replay envelope (size).
    var localEntry = Object.assign({}, entry);
    delete localEntry.replay;
    list.push(localEntry);
    // Tie-break: completion handled upstream; here: score desc, invalid asc,
    // duration asc, stable session id.
    data.boards[entry.board] = sortBoardEntries(list).slice(0, 50);
    writeJson(BOARD_KEY, data);
    // Clients never submit to the platform leaderboard. The game's own local
    // dev server still accepts replay-validated claims (dev server only).
    if (devApiAvailable()) {
      apiFetch('/api/v1/scores', { method: 'POST', body: entry }).catch(function () {});
    }
    return data.boards[entry.board];
  }

  function getBoard(name) {
    return (loadBoards().boards[name] || []).slice();
  }

  // Union remote board entries into the local copy (dedupe by session id).
  // Returns true when anything changed.
  function mergeBoards(remote) {
    if (!remote || typeof remote !== 'object' || !remote.boards) return false;
    var data = loadBoards();
    var changed = false;
    var names = {};
    Object.keys(data.boards || {}).forEach(function (k) { names[k] = 1; });
    Object.keys(remote.boards).forEach(function (k) { names[k] = 1; });
    Object.keys(names).forEach(function (k) {
      var seen = {};
      var list = [];
      ((data.boards && data.boards[k]) || []).concat(remote.boards[k] || []).forEach(function (e) {
        if (!e || !e.score) return;
        var id = String(k) + '|' + String(e.sessionId);
        if (seen[id]) return;
        seen[id] = 1;
        list.push(e);
      });
      sortBoardEntries(list);
      var trimmed = list.slice(0, 50);
      if (JSON.stringify(trimmed) !== JSON.stringify((data.boards && data.boards[k]) || [])) {
        data.boards[k] = trimmed;
        changed = true;
      }
    });
    if (changed) writeJson(BOARD_KEY, data);
    return changed;
  }

  // Read-only hosted leaderboard: game info -> leaderboardId -> entries,
  // with user ids resolved to nicknames via the profile helper.
  function getHostedLeaderboard() {
    if (!hosted || !launch.slug) return Promise.resolve(null);
    return apiFetch('/api/v1/games/' + encodeURIComponent(launch.slug)).then(function (info) {
      var lbId = info && info.leaderboardId;
      if (!lbId) return null;
      return apiFetch('/api/v1/leaderboards/' + encodeURIComponent(lbId)
        + '/entries?page=1&pageSize=10').then(function (res) {
        var list = res && (res.entries || (Array.isArray(res.items) ? res.items : null));
        if (!list || !list.length) return { me: info.me || null, entries: [] };
        return Promise.all(list.map(function (e) {
          var uid = e && (e.userId || e.user_id || (e.user && e.user.id) || e.id);
          return profileNameFor(uid).then(function (name) {
            return { rank: e.rank, name: name, score: e.score };
          });
        })).then(function (entries) { return { me: info.me || null, entries: entries }; });
      });
    }).catch(function () { return null; });
  }

  // ---------------------------------------------------------------- time sync
  // Round-trip-adjusted offset against the local dev server's clock. The
  // StarHermit host has no client-reachable time endpoint, so on-platform the
  // daily boundary follows the device clock (dailyClockMode() reports this).

  var clockOffsetMs = 0;
  var clockSyncedFlag = false;

  function syncTime() {
    if (!devApiAvailable()) return Promise.resolve(0);
    var t0 = Date.now();
    return apiFetch('/api/v1/time').then(function (res) {
      var t1 = Date.now();
      if (res && typeof res.now === 'number') {
        clockOffsetMs = res.now - Math.floor((t0 + t1) / 2);
        clockSyncedFlag = true;
      }
      return clockOffsetMs;
    }).catch(function () { return 0; });
  }

  function clockSynced() { return clockSyncedFlag; }

  function now() { return new Date(Date.now() + clockOffsetMs); }

  // ---------------------------------------------------------------- REST adapter

  function apiHeaders(withContentType) {
    var h = {};
    if (withContentType) h['Content-Type'] = 'application/json';
    if (launch.token) h['Authorization'] = 'Bearer ' + launch.token;
    return h;
  }

  // Hosted iff a launch token was read — never hostname probing, and no
  // check may force-disable hosted mode on *.starhermit.com hosts.
  function apiAvailable() { return hosted; }

  // The game's own server.js surface (time/scores/boards/presence/activity/
  // telemetry) exists only on the local dev server, and is used only there.
  function devApiAvailable() {
    if (hosted) return false;
    if (!global.location || !/^https?:$/.test(global.location.protocol)) return false;
    return isLocalDevHost(global.location.hostname);
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    return global.fetch(path, {
      method: opts.method || 'GET',
      headers: apiHeaders(true),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    }).then(function (res) {
      if (res.status === 429) { // rate limit: recoverable UI state
        var e = new Error('rate-limited'); e.code = 'rate-limited'; throw e;
      }
      return res.json().then(function (body) {
        if (body && body.error) { var err = new Error(body.error); err.code = body.error; throw err; }
        if (!res.ok) { var err2 = new Error('http-' + res.status); err2.code = err2.message; throw err2; }
        return body;
      });
    });
  }

  // Raw byte fetch for the cloud-saves slot (application/zip; 404 = none).
  function apiFetchBytes(path) {
    return global.fetch(path, {
      method: 'GET',
      headers: apiHeaders(false),
      credentials: 'same-origin'
    }).then(function (res) {
      if (res.status === 404) return { status: 404, ok: false, bytes: null };
      return res.arrayBuffer().then(function (buf) {
        return { status: res.status, ok: res.ok, bytes: buf };
      });
    });
  }

  // ---------------------------------------------------------------- identity
  // Nickname from GET /api/v1/users/{sub}/profile (NEVER /api/v1/me, never
  // usernames). Fallback: "Player " + id.slice(0,8). Surfaced through the
  // status listeners together with the cloud sync state.

  var identity = { sub: launch.sub, name: launch.sub ? 'Player ' + String(launch.sub).slice(0, 8) : null };
  var nameCache = {};
  var statusListeners = [];
  var syncState = hosted ? 'saving' : 'offline';

  function emitStatus() {
    var s = { name: identity.name, sub: identity.sub, hosted: hosted, sync: syncState };
    statusListeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
  }

  function onStatus(fn) {
    statusListeners.push(fn);
    try { fn({ name: identity.name, sub: identity.sub, hosted: hosted, sync: syncState }); } catch (e) {}
  }

  function setSync(state) {
    if (syncState === state) return;
    syncState = state;
    emitStatus();
  }

  function fetchProfile() {
    if (!hosted || !launch.sub) return;
    apiFetch('/api/v1/users/' + encodeURIComponent(launch.sub) + '/profile').then(function (res) {
      var nick = res && res.nickname;
      if (nick && String(nick).trim()) identity.name = String(nick);
      emitStatus();
    }).catch(function () { emitStatus(); }); // fallback name is already set
  }

  function profileNameFor(userId) {
    if (userId === undefined || userId === null) return Promise.resolve('Player');
    var key = String(userId);
    if (nameCache[key]) return Promise.resolve(nameCache[key]);
    return apiFetch('/api/v1/users/' + encodeURIComponent(key) + '/profile').then(function (res) {
      var nick = res && res.nickname;
      var name = (nick && String(nick).trim()) ? String(nick) : 'Player ' + key.slice(0, 8);
      nameCache[key] = name;
      return name;
    }).catch(function () { return 'Player ' + key.slice(0, 8); });
  }

  // ---------------------------------------------------------------- cloud save
  // One platform slot: PUT/GET /api/v1/me/cloud-saves/{slug} with a stored
  // zip (single JSON entry) base64-encoded. Saves debounce ~2 s and flush on
  // pagehide/visibilitychange; loads prefer the remote copy when newer.

  var cloudPending = null;
  var cloudTimer = 0;

  function cloudPath() {
    return '/api/v1/me/cloud-saves/' + encodeURIComponent(launch.slug);
  }

  function sendCloud(payloadStr) {
    var bytes = zipStore(SAVE_ENTRY_NAME, new TextEncoder().encode(payloadStr));
    return apiFetch(cloudPath(), {
      method: 'PUT',
      body: { dataBase64: bytesToBase64(bytes) }
    });
  }

  function scheduleCloudSave(doc) {
    if (!hosted || !launch.slug) return;
    cloudPending = JSON.stringify({
      kind: CLOUD_KIND,
      savedAt: new Date().toISOString(),
      save: doc,
      boards: loadBoards()
    });
    if (!cloudTimer) {
      setSync('saving');
      cloudTimer = setTimeout(flushCloudSave, CLOUD_DEBOUNCE_MS);
    }
  }

  function flushCloudSave() {
    if (cloudTimer) { clearTimeout(cloudTimer); cloudTimer = 0; }
    if (!hosted || !launch.slug || !cloudPending) return;
    var payload = cloudPending;
    setSync('saving');
    sendCloud(payload).then(function () {
      if (cloudPending === payload) cloudPending = null;
      setSync('synced');
    }).catch(function () {
      // Keep the pending payload for the next persist/flush retry.
      if (!cloudPending) cloudPending = payload;
      setSync('error');
    });
  }

  // Returns the decoded cloud wrapper { save, boards }, or null when absent
  // or unreachable. Never throws.
  function loadCloudSave() {
    if (!hosted || !launch.slug || !global.fetch) return Promise.resolve(null);
    setSync('saving');
    return apiFetchBytes(cloudPath()).then(function (res) {
      if (!res) { setSync(hosted ? 'error' : 'offline'); return null; }
      if (res.status === 404) { setSync('synced'); return null; }
      if (!res.ok || !res.bytes || !res.bytes.byteLength) { setSync('error'); return null; }
      try {
        var raw = unzipFirstEntry(new Uint8Array(res.bytes));
        var parsed = JSON.parse(new TextDecoder().decode(raw));
        setSync('synced');
        if (parsed && typeof parsed === 'object' && parsed.save) return parsed;
        // Tolerate a bare save document in the slot.
        if (parsed && typeof parsed === 'object') return { save: parsed, boards: null };
        return null;
      } catch (e) {
        setSync('error');
        return null;
      }
    }).catch(function () { setSync('error'); return null; });
  }

  // Wiping progress resets the cloud mirror too (best effort).
  function wipeCloudSave() {
    cloudPending = null;
    if (cloudTimer) { clearTimeout(cloudTimer); cloudTimer = 0; }
    if (!hosted || !launch.slug || !global.fetch) return;
    try {
      sendCloud(JSON.stringify({
        kind: CLOUD_KIND,
        savedAt: new Date().toISOString(),
        save: emptySave(),
        boards: { boards: {} }
      })).catch(function () {});
    } catch (e) {}
  }

  if (global.addEventListener) {
    global.addEventListener('pagehide', flushCloudSave);
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flushCloudSave();
    });
  }

  // ---------------------------------------------------------------- token refresh
  // Tokens live 60 min; re-mint every 45 min via the scoped launch-token
  // route, swap the new token in, and retry failures after ~60 s.

  var refreshTimer = 0;

  function scheduleTokenRefresh() {
    if (!hosted || !launch.slug) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshLaunchToken, TOKEN_REFRESH_MS);
  }

  function refreshLaunchToken() {
    apiFetch('/api/v1/games/' + encodeURIComponent(launch.slug) + '/launch-token', {
      method: 'POST',
      body: {}
    }).then(function (res) {
      if (res && typeof res.token === 'string' && res.token) {
        launch.token = res.token;
        var payload = b64urlJson(String(res.token).split('.')[1]);
        if (payload) {
          if (payload.sub) { launch.sub = payload.sub; identity.sub = payload.sub; }
          if (payload.game_scope) launch.slug = payload.game_scope;
        }
        emitStatus();
      }
      scheduleTokenRefresh();
    }).catch(function () {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshLaunchToken, TOKEN_RETRY_MS);
    });
  }

  // ---------------------------------------------------------------- telemetry
  // Anonymous funnel events only, and only with consent, and only to the
  // game's own local dev server — the StarHermit host has no client-reachable
  // telemetry endpoint. Never raw text, never pointer trails.

  var sessionUuid = null;
  function telemetrySessionId() {
    if (!sessionUuid) {
      sessionUuid = 'anon-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    return sessionUuid;
  }

  var ALLOWED_EVENTS = { 'start': 1, 'tutorial-step': 1, 'round-end': 1, 'retry': 1, 'settings-change': 1, 'error': 1 };

  function telemetry(event, data) {
    if (!ALLOWED_EVENTS[event]) return;
    if (!settings.telemetryConsent) return;
    if (!devApiAvailable() || !global.navigator || !global.fetch) return;
    try {
      global.fetch('/api/v1/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: event, session: telemetrySessionId(), data: data || {}, at: Date.now() }),
        credentials: 'same-origin'
      }).catch(function () {});
    } catch (e) { /* never let telemetry break play */ }
  }

  // ---------------------------------------------------------------- init & expose

  if (hosted) {
    fetchProfile();
    scheduleTokenRefresh();
  }

  global.OCPlatform = {
    SAVE_VERSION: SAVE_VERSION,
    getSettings: getSettings,
    updateSettings: updateSettings,
    loadSave: loadSave,
    persistSave: persistSave,
    migrateSave: migrateSave,
    emptySave: emptySave,
    adoptSave: adoptSave,
    checksum: checksum,
    submitScore: submitScore,
    getBoard: getBoard,
    mergeBoards: mergeBoards,
    getHostedLeaderboard: getHostedLeaderboard,
    syncTime: syncTime,
    clockSynced: clockSynced,
    now: now,
    apiFetch: apiFetch,
    apiAvailable: apiAvailable,
    devApiAvailable: devApiAvailable,
    loadCloudSave: loadCloudSave,
    wipeCloudSave: wipeCloudSave,
    getIdentity: function () {
      return { name: identity.name, sub: identity.sub, hosted: hosted, slug: launch.slug };
    },
    onStatus: onStatus,
    telemetry: telemetry,
    telemetrySessionId: telemetrySessionId
  };
})(typeof self !== 'undefined' ? self : this);
