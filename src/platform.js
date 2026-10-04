/*
 * Open Cells — platform layer.
 * StarHermit integration goes through the shared SDK (src/starhermit-sdk.js,
 * window.StarHermit): launch token (#game_token / #access_token, read once and
 * stripped, renewed by the SDK), profile nickname, `game:<slug>` cloud save
 * mirror (localStorage stays the offline cache), per-player settings KV,
 * keyboard bindings, sign-in and invite link. This file adds the versioned
 * checksummed save document, per-game settings, local boards + the read-only
 * hosted leaderboard, and degrades gracefully to fully offline play. Without
 * a launch token it makes no network request at all (device clock, local
 * boards, no presence/activity/telemetry); signed in, the platform clock is
 * read via the SDK. Browser only. Exposes window.OCPlatform.
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
  };

  // ---------------------------------------------------------------- launch token
  // The SDK reads the launch fragment once (#game_token=<jwt>[&session_id=]
  // or #access_token=<jwt> after a direct sign-in) and strips it; hosted
  // mode is "the SDK holds a token". Query-string tokens are a local-dev
  // convenience of the SDK.

  var SH = global.StarHermit || null;
  if (SH) SH.init();

  function isHosted() { return !!(SH && SH.signedIn && SH.slug); }

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
    if (JSON.stringify(settings) !== before) {
      if (Object.keys(patch).some(function (k) { return KV_KEYS.indexOf(k) >= 0; })) patchPlatformSettings();
    }
    return getSettings();
  }

  // Player preferences mirrored to the StarHermit settings KV (the account
  // value wins at boot). Progress flags and keybindings are not preferences
  // here: bindings live in the platform controls store.
  var KV_KEYS = ['theme', 'graphics', 'reducedMotion', 'highContrast', 'largerText', 'leftHanded', 'holdToDrag',
    'haptics', 'colorPalette', 'volume', 'muted'];

  function patchPlatformSettings() {
    if (!isHosted()) return;
    var o = {};
    KV_KEYS.forEach(function (k) { o[k] = settings[k] === undefined ? null : settings[k]; });
    SH.patchSettings(o);
  }

  // Resolves the merged settings after applying the account's KV values.
  function loadPlatformSettings() {
    if (!isHosted()) return Promise.resolve(null);
    return SH.getSettings().then(function (kv) {
      if (!kv) return null;
      var patch = {};
      KV_KEYS.forEach(function (k) { if (kv[k] !== undefined && kv[k] !== null) patch[k] = kv[k]; });
      if (!Object.keys(patch).length) return null;
      if (patch.volume) settings.volume = Object.assign({}, settings.volume, patch.volume);
      var p = Object.assign({}, patch); delete p.volume;
      settings = Object.assign({}, settings, p);
      writeJson(SETTINGS_KEY, settings);
      return getSettings();
    }).catch(function () { return null; });
  }

  // Keyboard bindings: { action: [codes] } with the platform's rebinds.
  function loadBindings(defaults) {
    var copy = JSON.parse(JSON.stringify(defaults));
    if (!isHosted()) return Promise.resolve(copy);
    return SH.loadBindings(defaults).catch(function () { return copy; });
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
    // Clients never submit scores anywhere: local board only (cloud-saved
    // when signed in).
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

  // Read-only hosted leaderboard: the game's first platform board, with user
  // ids resolved to nicknames via the profile helper.
  function getHostedLeaderboard() {
    if (!isHosted()) return Promise.resolve(null);
    return Promise.all([SH.leaderboard(null, { pageSize: 10 }), SH.getGame()]).then(function (r) {
      var res = r[0], info = r[1];
      if (!res || !res.board) return null;
      var me = (info && info.me) || null;
      return Promise.all((res.items || []).map(function (e) {
        return profileNameFor(e && e.userId).then(function (name) {
          return { rank: e.rank, name: name, score: e.score };
        });
      })).then(function (entries) { return { me: me, entries: entries }; });
    }).catch(function () { return null; });
  }

  // ---------------------------------------------------------------- time sync
  // Round-trip-adjusted offset against the platform clock (GET /api/v1/time),
  // signed in only. Standalone the daily boundary follows the device clock.

  var clockOffsetMs = 0;
  var clockSyncedFlag = false;

  function syncTime() {
    if (!isHosted()) return Promise.resolve(0);
    var t0 = Date.now();
    return SH.api('/api/v1/time').then(function (res) {
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

  // Hosted iff the SDK holds a launch token — never hostname probing.
  function apiAvailable() { return isHosted(); }

  // ---------------------------------------------------------------- identity
  // Nickname from the profile (NEVER /api/v1/me). Fallback: "Player " + id
  // prefix. Surfaced through the status listeners with the cloud sync state.

  function fallbackName(id) { return id ? 'Player ' + String(id).slice(0, 6) : null; }
  var identity = { sub: isHosted() ? SH.userId : null, name: isHosted() ? fallbackName(SH.userId) : null, avatar: null };
  var statusListeners = [];
  var syncState = isHosted() ? 'saving' : 'offline';

  function statusSnapshot() {
    return { name: identity.name, sub: identity.sub, avatar: identity.avatar, hosted: isHosted(), sync: syncState };
  }

  function emitStatus() {
    var s = statusSnapshot();
    statusListeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
  }

  function onStatus(fn) {
    statusListeners.push(fn);
    try { fn(statusSnapshot()); } catch (e) {}
  }

  function setSync(state) {
    if (syncState === state) return;
    syncState = state;
    emitStatus();
  }

  function fetchProfile() {
    if (!isHosted()) return;
    SH.profile().then(function (p) {
      if (p && p.displayName) identity.name = p.displayName;
      emitStatus();
    }).catch(function () { emitStatus(); }); // fallback name is already set
    SH.avatarUrl().then(function (url) {
      if (url) { identity.avatar = url; emitStatus(); }
    }).catch(function () {});
  }

  function profileNameFor(userId) {
    if (userId === undefined || userId === null) return Promise.resolve('Player');
    return SH.profile(String(userId)).then(function (p) {
      return (p && p.displayName) || fallbackName(userId);
    }).catch(function () { return fallbackName(userId); });
  }

  // ---------------------------------------------------------------- cloud save
  // One platform slot: PUT/GET /api/v1/me/cloud-saves/{slug} with a stored
  // zip (single JSON entry) base64-encoded. Saves debounce ~2 s and flush on
  // pagehide/visibilitychange; loads prefer the remote copy when newer.

  var cloudPending = null;
  var cloudTimer = 0;

  function sendCloud(payloadStr) {
    return SH.writeSave(payloadStr, { keepalive: true }).then(function (ok) {
      if (!ok) throw new Error('cloud-save-failed');
    });
  }

  function scheduleCloudSave(doc) {
    if (!isHosted()) return;
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
    if (!isHosted() || !cloudPending) return Promise.resolve();
    var payload = cloudPending;
    setSync('saving');
    return sendCloud(payload).then(function () {
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
    if (!isHosted()) return Promise.resolve(null);
    setSync('saving');
    return SH.loadJSON().then(function (parsed) {
      setSync('synced');
      if (parsed && typeof parsed === 'object' && parsed.save) return parsed;
      // Tolerate a bare save document in the slot.
      if (parsed && typeof parsed === 'object') return { save: parsed, boards: null };
      return null;
    }).catch(function () { setSync('error'); return null; });
  }

  // Wiping progress resets the cloud mirror too (best effort).
  function wipeCloudSave() {
    cloudPending = null;
    if (cloudTimer) { clearTimeout(cloudTimer); cloudTimer = 0; }
    if (!isHosted()) return;
    sendCloud(JSON.stringify({
      kind: CLOUD_KIND,
      savedAt: new Date().toISOString(),
      save: emptySave(),
      boards: { boards: {} }
    })).catch(function () {});
  }

  if (global.addEventListener) {
    global.addEventListener('pagehide', function () { flushCloudSave(); });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flushCloudSave();
    });
  }

  // Auth changes (renewal refused → signed out): drop the account line and
  // keep playing locally; listeners re-render sign-in / invite buttons.
  var authListeners = [];
  var wasSignedIn = isHosted();
  if (SH) {
    SH.on('auth', function (a) {
      if (a.signedIn === wasSignedIn) return; // renewals change nothing visible
      wasSignedIn = a.signedIn;
      if (!a.signedIn) { identity.name = null; identity.sub = null; identity.avatar = null; syncState = 'offline'; emitStatus(); }
      authListeners.forEach(function (fn) { try { fn(a); } catch (e) {} });
    });
  }
  function onAuth(fn) { authListeners.push(fn); }

  // ---------------------------------------------------------------- init & expose

  fetchProfile();

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
    apiAvailable: apiAvailable,
    loadCloudSave: loadCloudSave,
    wipeCloudSave: wipeCloudSave,
    getIdentity: function () {
      return { name: identity.name, sub: identity.sub, hosted: isHosted(), slug: SH ? SH.slug : null };
    },
    flushCloudSave: flushCloudSave,
    loadPlatformSettings: loadPlatformSettings,
    loadBindings: loadBindings,
    onAuth: onAuth,
    canSignIn: function () { return !!(SH && SH.canSignIn()); },
    signIn: function () { return !!(SH && SH.signIn()); },
    inviteLink: function () { return isHosted() ? SH.inviteLink() : null; },
    onStatus: onStatus
  };
})(typeof self !== 'undefined' ? self : this);
