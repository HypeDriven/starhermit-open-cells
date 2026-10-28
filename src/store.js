'use strict';
/*
 * Open Cells — the save document, the local score boards and the game's own
 * options. Pure (no storage, no platform): the engine client
 * (native/platform.ts) and the node tests share it. Moved here from the
 * browser build's src/platform.js, unchanged in what it decides.
 *
 * The engine save holds { save, boards }: `save` is the versioned progress
 * document (journey stars and bests, lessons, dailies and the streak,
 * achievements, totals, the resumable deal), `boards` the local personal-best
 * boards ({ boards: { name: [entry…] } }). The browser build kept them in
 * localStorage (open-cells/save/v1 in a checksummed envelope,
 * open-cells/boards/v1) and mirrored both to the cloud slot game:<slug> as
 * { kind: 'open-cells/cloud/v1', savedAt, save, boards } (the JS SDK's
 * saveJSON); readForeign reads that text, mergeData is the browser build's
 * merge (mergeSaves + mergeBoards).
 *
 * The game's own options (table theme, left-handed tray, hold to drag,
 * haptics, suit colour palette, tutorial complete) were browser settings
 * mirrored into the account's settings KV; the engine keeps them as its
 * settings (same keys). The rest (volumes, mute, graphics, reduced motion,
 * high contrast, larger text, language) are the runtime's Options now, and
 * their KV keys are removed.
 * UMD: module.exports in Node, globalThis.OCStore for loadClassic.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OCStore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  var SAVE_VERSION = 1;
  var CLOUD_KIND = 'open-cells/cloud/v1';
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }

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

  // Save migrations run in order; keep them forever.
  var MIGRATIONS = {};
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
  /** A save document from anything (missing fields from the empty save). */
  function adoptSave(doc) {
    if (!obj(doc)) return emptySave();
    doc = clone(doc);
    if (doc.version !== SAVE_VERSION) doc = migrateSave(doc);
    var out = Object.assign(emptySave(), doc);
    ['journey', 'lessons', 'dailies', 'achievements'].forEach(function (k) { out[k] = obj(out[k]) || {}; });
    out.dailyStreak = Object.assign({ count: 0, lastDate: null }, obj(out.dailyStreak) || {});
    out.totals = Object.assign({ foundations: 0, wins: 0, played: 0 }, obj(out.totals) || {});
    return out;
  }

  // Merge two save documents (another device saved since, or the old cloud
  // slot): every completion, best and unlock from either side survives; the
  // local side's in-progress deal wins.
  function mergeSaves(remote, local) {
    var a = adoptSave(remote), b = adoptSave(local);
    function earlier(x, y) { return !x ? y : !y ? x : (String(x) < String(y) ? x : y); }
    var out = emptySave();
    Object.keys(Object.assign({}, a.journey, b.journey)).forEach(function (id) {
      var x = a.journey[id], y = b.journey[id];
      if (!x || !y) { out.journey[id] = x || y; return; }
      out.journey[id] = {
        stars: Math.max(x.stars || 0, y.stars || 0),
        bestScore: Math.max(x.bestScore || 0, y.bestScore || 0),
        bestMoves: Math.min(x.bestMoves != null ? x.bestMoves : Infinity, y.bestMoves != null ? y.bestMoves : Infinity),
        completedAt: earlier(x.completedAt, y.completedAt)
      };
      if (!isFinite(out.journey[id].bestMoves)) out.journey[id].bestMoves = null;
    });
    Object.keys(Object.assign({}, a.lessons, b.lessons)).forEach(function (id) {
      var x = a.lessons[id], y = b.lessons[id];
      out.lessons[id] = x && y ? { completedAt: earlier(x.completedAt, y.completedAt) } : (x || y);
    });
    Object.keys(Object.assign({}, a.dailies, b.dailies)).forEach(function (d) {
      var x = a.dailies[d], y = b.dailies[d];
      out.dailies[d] = !x ? y : !y ? x : ((y.score || 0) > (x.score || 0) ? y : x);
    });
    var sa = a.dailyStreak || {}, sb = b.dailyStreak || {};
    out.dailyStreak = String(sa.lastDate || '') === String(sb.lastDate || '')
      ? { count: Math.max(sa.count || 0, sb.count || 0), lastDate: sa.lastDate || sb.lastDate || null }
      : (String(sa.lastDate || '') > String(sb.lastDate || '') ? sa : sb);
    Object.keys(Object.assign({}, a.achievements, b.achievements)).forEach(function (k) {
      out.achievements[k] = earlier(a.achievements[k], b.achievements[k]);
    });
    ['foundations', 'wins', 'played'].forEach(function (k) {
      out.totals[k] = Math.max((a.totals && a.totals[k]) || 0, (b.totals && b.totals[k]) || 0);
    });
    out.lastSnapshot = b.lastSnapshot || a.lastSnapshot || null;
    out.updatedAt = String(a.updatedAt || '') > String(b.updatedAt || '') ? a.updatedAt : b.updatedAt;
    return out;
  }

  // ---------------------------------------------------------------- boards
  function emptyBoards() { return { boards: {} }; }
  function sortBoardEntries(list) {
    list.sort(function (a, b) {
      if (b.score.total !== a.score.total) return b.score.total - a.score.total;
      if (a.invalid !== b.invalid) return a.invalid - b.invalid;
      if (a.durationMs !== b.durationMs) return a.durationMs - b.durationMs;
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });
    return list;
  }
  function adoptBoards(raw) {
    var r = obj(raw), out = emptyBoards();
    if (!r || !obj(r.boards)) return out;
    Object.keys(r.boards).forEach(function (k) {
      if (Array.isArray(r.boards[k])) out.boards[k] = r.boards[k].filter(function (e) { return e && e.score; });
    });
    return out;
  }
  /** Boards after a finished deal's entry (score desc, invalid asc, duration asc; top 50; no replay copy). */
  function addEntry(boards, entry) {
    var data = adoptBoards(boards);
    var list = data.boards[entry.board] || [];
    var local = Object.assign({}, entry);
    delete local.replay;
    list.push(local);
    data.boards[entry.board] = sortBoardEntries(list).slice(0, 50);
    return data;
  }
  /** Union of two board sets (deduplicated by session id). */
  function mergeBoards(a, b) {
    var x = adoptBoards(a), y = adoptBoards(b), out = emptyBoards();
    Object.keys(Object.assign({}, x.boards, y.boards)).forEach(function (k) {
      var seen = {}, list = [];
      (x.boards[k] || []).concat(y.boards[k] || []).forEach(function (e) {
        var id = String(e.sessionId);
        if (seen[id]) return;
        seen[id] = 1;
        list.push(e);
      });
      out.boards[k] = sortBoardEntries(list).slice(0, 50);
    });
    return out;
  }

  // ---------------------------------------------------------------- the engine save
  /** The engine save document { save, boards } from anything. */
  function normalize(raw) {
    var r = obj(raw) || {};
    return { save: adoptSave(r.save), boards: adoptBoards(r.boards) };
  }
  /** Merge two engine save documents; `local`'s in-progress deal wins. */
  function mergeData(local, remote) {
    var l = normalize(local), r = normalize(remote);
    return { save: mergeSaves(r.save, l.save), boards: mergeBoards(l.boards, r.boards) };
  }
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  /** Same progress (updatedAt aside). */
  function same(a, b) {
    var x = normalize(a), y = normalize(b);
    x.save.updatedAt = y.save.updatedAt = null;
    return canon(x) === canon(y);
  }
  /** The browser build's cloud slot text ({ kind, savedAt, save, boards } or a bare save), or null. */
  function readForeign(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
      var d = JSON.parse(text);
      if (!obj(d)) return null;
      if (obj(d.save)) return normalize({ save: d.save, boards: d.boards });
      return normalize({ save: d, boards: null });
    } catch (e) { return null; }
  }
  // Small stable checksum (FNV-1a), the browser build's save envelope.
  function checksum(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ---------------------------------------------------------------- options
  var PALETTES = ['standard', 'deuteranopia', 'tritanopia'];
  var THEME_IDS = ['brass-slate', 'verdigris', 'night-ink', 'parchment', 'contrast'];
  var DEFAULT_OPTIONS = { theme: 'brass-slate', leftHanded: false, holdToDrag: false, haptics: true, colorPalette: 'standard', tutorialComplete: false };
  var OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
  /** The valid option values in raw (others left out). */
  function pickOptions(raw) {
    var r = obj(raw) || {}, out = {};
    ['leftHanded', 'holdToDrag', 'haptics', 'tutorialComplete'].forEach(function (k) { if (typeof r[k] === 'boolean') out[k] = r[k]; });
    if (PALETTES.indexOf(r.colorPalette) >= 0) out.colorPalette = r.colorPalette;
    if (THEME_IDS.indexOf(r.theme) >= 0) out.theme = r.theme;
    return out;
  }
  // Every key the browser build wrote to the account's settings KV (platform.js
  // KV_KEYS and sh-language.js's ui.language).
  var BROWSER_KEYS = ['theme', 'graphics', 'reducedMotion', 'highContrast', 'largerText', 'leftHanded', 'holdToDrag',
    'haptics', 'colorPalette', 'volume', 'muted', 'ui.language'];

  return {
    SAVE_VERSION: SAVE_VERSION, CLOUD_KIND: CLOUD_KIND,
    emptySave: emptySave, adoptSave: adoptSave, migrateSave: migrateSave, mergeSaves: mergeSaves,
    emptyBoards: emptyBoards, addEntry: addEntry, mergeBoards: mergeBoards,
    normalize: normalize, mergeData: mergeData, same: same, readForeign: readForeign, checksum: checksum,
    PALETTES: PALETTES, THEME_IDS: THEME_IDS, DEFAULT_OPTIONS: DEFAULT_OPTIONS, OPTION_KEYS: OPTION_KEYS,
    pickOptions: pickOptions, BROWSER_KEYS: BROWSER_KEYS
  };
});
