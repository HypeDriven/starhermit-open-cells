/*
 * Open Cells — platform layer.
 * Local persistence (versioned, checksummed save document), per-game settings,
 * leaderboards, time synchronization with the host, telemetry consent, and a
 * token-aware REST adapter that degrades gracefully to fully offline play.
 * Browser only (uses localStorage/fetch). Exposes window.OCPlatform.
 */
(function (global) {
  'use strict';

  var SAVE_KEY = 'open-cells/save/v1';
  var SETTINGS_KEY = 'open-cells/settings/v1';
  var BOARD_KEY = 'open-cells/boards/v1';
  var SAVE_VERSION = 1;

  var DEFAULT_SETTINGS = {
    theme: 'brass-slate',
    quality: 'auto',            // 'auto' | 'low' | 'medium' | 'high'
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
  // Versioned, checksummed progression document. Conflicts are surfaced to the
  // caller (preserve-both) rather than silently overwritten.

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
    if (doc.checksum !== checksum(doc.payload)) {
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

  function persistSave(doc) {
    doc.updatedAt = new Date().toISOString();
    var payload = JSON.stringify(doc);
    return writeJson(SAVE_KEY, { checksum: checksum(payload), payload: payload });
  }

  // ---------------------------------------------------------------- boards
  // Local leaderboards; when hosted, the REST adapter submits remotely too.
  // Every entry carries ruleset, content version, seed, assists, duration.

  function loadBoards() { return readJson(BOARD_KEY, { boards: {} }); }

  function submitScore(entry) {
    // entry: { board, dealId, seed, ruleset, contentVersion, score, assists,
    //          durationMs, moves, invalid, sessionId, at }
    var data = loadBoards();
    var list = data.boards[entry.board] || [];
    // Local copies drop the replay envelope (size); remote keeps it.
    var localEntry = Object.assign({}, entry);
    delete localEntry.replay;
    list.push(localEntry);
    // Tie-break: completion handled upstream; here: score desc, invalid asc,
    // duration asc, stable session id.
    list.sort(function (a, b) {
      if (b.score.total !== a.score.total) return b.score.total - a.score.total;
      if (a.invalid !== b.invalid) return a.invalid - b.invalid;
      if (a.durationMs !== b.durationMs) return a.durationMs - b.durationMs;
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });
    data.boards[entry.board] = list.slice(0, 50);
    writeJson(BOARD_KEY, data);
    // Best-effort hosted submission; failure is not an error state locally.
    if (apiAvailable()) {
      apiFetch('/api/v1/scores', { method: 'POST', body: entry }).catch(function () {});
    }
    return data.boards[entry.board];
  }

  function getBoard(name) {
    return (loadBoards().boards[name] || []).slice();
  }

  // ---------------------------------------------------------------- time sync
  // Round-trip-adjusted offset against the host clock when available.

  var clockOffsetMs = 0;

  function syncTime() {
    if (!apiAvailable()) return Promise.resolve(0);
    var t0 = Date.now();
    return apiFetch('/api/v1/time').then(function (res) {
      var t1 = Date.now();
      if (res && typeof res.now === 'number') {
        clockOffsetMs = res.now - Math.floor((t0 + t1) / 2);
      }
      return clockOffsetMs;
    }).catch(function () { return 0; });
  }

  function now() { return new Date(Date.now() + clockOffsetMs); }

  // ---------------------------------------------------------------- REST adapter

  function apiAvailable() {
    // Hosted when served over http(s) with a same-origin /api route. We probe
    // lazily and cache the verdict so offline file:// play never stalls.
    if (apiAvailable._verdict !== undefined) return apiAvailable._verdict;
    if (!global.location || !/^https?:$/.test(global.location.protocol)) {
      apiAvailable._verdict = false;
      return false;
    }
    return true; // optimistic; individual failures degrade per-call
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    return global.fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    }).then(function (res) {
      if (res.status === 429) { // rate limit: recoverable UI state
        var e = new Error('rate-limited'); e.code = 'rate-limited'; throw e;
      }
      return res.json().then(function (body) {
        if (body && body.error) { var err = new Error(body.error); err.code = body.error; throw err; }
        return body;
      });
    });
  }

  // ---------------------------------------------------------------- telemetry
  // Anonymous funnel events only, and only with consent. Never raw text,
  // never pointer trails, never cross-title identifiers.

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
    if (!apiAvailable() || !global.navigator || !global.fetch) return;
    try {
      global.fetch('/api/v1/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: event, session: telemetrySessionId(), data: data || {}, at: Date.now() }),
        credentials: 'same-origin'
      }).catch(function () {});
    } catch (e) { /* never let telemetry break play */ }
  }

  // ---------------------------------------------------------------- expose

  global.OCPlatform = {
    SAVE_VERSION: SAVE_VERSION,
    getSettings: getSettings,
    updateSettings: updateSettings,
    loadSave: loadSave,
    persistSave: persistSave,
    migrateSave: migrateSave,
    emptySave: emptySave,
    checksum: checksum,
    submitScore: submitScore,
    getBoard: getBoard,
    syncTime: syncTime,
    now: now,
    apiFetch: apiFetch,
    apiAvailable: apiAvailable,
    telemetry: telemetry,
    telemetrySessionId: telemetrySessionId,
    _resetApiCache: function () { delete apiAvailable._verdict; }
  };
})(typeof self !== 'undefined' ? self : this);
