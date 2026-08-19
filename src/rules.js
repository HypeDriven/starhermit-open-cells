/*
 * Open Cells — rules engine.
 * Pure, deterministic, serializable. No DOM, no rendering, no wall-clock.
 * Works in the browser (window.OCRules) and in Node (module.exports) for tests.
 *
 * Conventions:
 *  - Cards are integers 0..51. id = suit * 13 + (rank - 1).
 *    Suits: 0 spades, 1 hearts, 2 diamonds, 3 clubs. Ranks: 1 (A) .. 13 (K).
 *  - Locations are plain objects: { zone: 'cell'|'foundation'|'tableau', index: 0..n }
 *  - All state is JSON-serializable. Engine functions never mutate input state.
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.OCRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var NUM_CELLS = 4;
  var NUM_SUITS = 4;
  var NUM_COLUMNS = 8;
  var DECK_SIZE = 52;

  var SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
  var SUIT_SYMBOLS = ['\u2660', '\u2665', '\u2666', '\u2663'];
  var RANK_LABELS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  // ---------------------------------------------------------------- cards

  function suitOf(id) { return Math.floor(id / 13); }
  function rankOf(id) { return (id % 13) + 1; }
  function colorOf(id) { var s = suitOf(id); return (s === 1 || s === 2) ? 'red' : 'black'; }
  function cardLabel(id) { return RANK_LABELS[rankOf(id) - 1] + SUIT_SYMBOLS[suitOf(id)]; }
  function isValidCard(id) { return Number.isInteger(id) && id >= 0 && id < DECK_SIZE; }

  // ---------------------------------------------------------------- rng

  // mulberry32 — small, fast, deterministic seeded stream.
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(str) {
    // FNV-1a 32-bit — stable across platforms, used to turn deal ids into seeds.
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // ---------------------------------------------------------------- dealing

  // Standard deal: columns 0..3 receive 7 cards, columns 4..7 receive 6.
  function deal(seed) {
    var rng = makeRng(seed);
    var deck = [];
    var i;
    for (i = 0; i < DECK_SIZE; i++) deck.push(i);
    for (i = DECK_SIZE - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    var tableau = [];
    for (i = 0; i < NUM_COLUMNS; i++) tableau.push([]);
    for (i = 0; i < DECK_SIZE; i++) tableau[i % NUM_COLUMNS].push(deck[i]);
    return tableau;
  }

  // ---------------------------------------------------------------- state

  function createState(options) {
    options = options || {};
    var seed = (options.seed >>> 0) || 1;
    var cells = [];
    for (var i = 0; i < NUM_CELLS; i++) cells.push(null);
    var constraints = Object.assign({
      cellsAvailable: NUM_CELLS,
      moveLimit: null,      // integer or null
      timeLimitMs: null,    // integer or null (challenge target; exceeding ends attempt)
      noAuto: false         // disable auto-foundation assist
    }, options.constraints || {});
    return {
      version: VERSION,
      dealId: options.dealId || ('deal-' + seed),
      seed: seed,
      ruleset: options.ruleset || 'open-cells/1',
      cells: cells,
      foundations: [[], [], [], []],
      tableau: options.tableau ? cloneTableau(options.tableau) : deal(seed),
      constraints: constraints,
      turn: 0,              // monotonically increasing tick — every command bumps it
      moves: 0,             // committed legal moves
      invalid: 0,           // rejected action attempts
      undos: 0,
      elapsedMs: 0,         // authoritative accumulated active time (integer)
      status: 'active',     // 'active' | 'won' | 'lost'
      terminalReason: null
    };
  }

  function cloneTableau(t) { return t.map(function (col) { return col.slice(); }); }

  function cloneState(s) {
    return {
      version: s.version,
      dealId: s.dealId,
      seed: s.seed,
      ruleset: s.ruleset,
      cells: s.cells.slice(),
      foundations: s.foundations.map(function (f) { return f.slice(); }),
      tableau: cloneTableau(s.tableau),
      constraints: Object.assign({}, s.constraints),
      turn: s.turn,
      moves: s.moves,
      invalid: s.invalid,
      undos: s.undos,
      elapsedMs: s.elapsedMs,
      status: s.status,
      terminalReason: s.terminalReason
    };
  }

  function serialize(s) { return JSON.stringify(s); }
  function deserialize(json) {
    var s = (typeof json === 'string') ? JSON.parse(json) : json;
    if (!s || typeof s !== 'object') throw new Error('bad state: not an object');
    if (s.version !== VERSION) throw new Error('unsupported state version: ' + s.version);
    validateStateShape(s);
    return cloneState(s);
  }

  function validateStateShape(s) {
    var seen = new Set();
    var i, j, id;
    if (!Array.isArray(s.cells) || s.cells.length !== NUM_CELLS) throw new Error('bad cells');
    if (!Array.isArray(s.foundations) || s.foundations.length !== NUM_SUITS) throw new Error('bad foundations');
    if (!Array.isArray(s.tableau) || s.tableau.length !== NUM_COLUMNS) throw new Error('bad tableau');
    function take(id) {
      if (!isValidCard(id)) throw new Error('bad card id: ' + id);
      if (seen.has(id)) throw new Error('duplicate card: ' + id);
      seen.add(id);
    }
    for (i = 0; i < NUM_CELLS; i++) if (s.cells[i] !== null) take(s.cells[i]);
    for (i = 0; i < NUM_SUITS; i++) {
      for (j = 0; j < s.foundations[i].length; j++) {
        id = s.foundations[i][j]; take(id);
        if (suitOf(id) !== i) throw new Error('wrong suit on foundation ' + i);
        if (rankOf(id) !== j + 1) throw new Error('broken foundation order');
      }
    }
    for (i = 0; i < NUM_COLUMNS; i++) for (j = 0; j < s.tableau[i].length; j++) take(s.tableau[i][j]);
    if (seen.size !== DECK_SIZE) throw new Error('deck incomplete: ' + seen.size + '/52');
    if (!Number.isInteger(s.turn) || s.turn < 0) throw new Error('bad turn');
    if (!Number.isInteger(s.moves) || s.moves < 0) throw new Error('bad moves');
  }

  // FNV-1a over canonical JSON — state hash for replay verification.
  function stateHash(s) {
    var canon = [s.cells, s.foundations, s.tableau, s.turn, s.moves, s.invalid, s.status];
    return hashString(JSON.stringify(canon)).toString(16).padStart(8, '0');
  }

  // ---------------------------------------------------------------- queries

  function topOfColumn(s, col) {
    var c = s.tableau[col];
    return c.length ? c[c.length - 1] : null;
  }

  // Length of the ordered (descending, alternating) run at the bottom of a column.
  function orderedRunLength(col) {
    var n = 1;
    for (var i = col.length - 1; i > 0; i--) {
      var upper = col[i], lower = col[i - 1];
      if (rankOf(upper) === rankOf(lower) - 1 && colorOf(upper) !== colorOf(lower)) n++;
      else break;
    }
    return n;
  }

  function freeCellCount(s) {
    var n = 0;
    for (var i = 0; i < NUM_CELLS; i++) if (i < s.constraints.cellsAvailable && s.cells[i] === null) n++;
    return n;
  }

  function emptyColumnCount(s, excludeCol) {
    var n = 0;
    for (var i = 0; i < NUM_COLUMNS; i++) {
      if (i === excludeCol) continue;
      if (s.tableau[i].length === 0) n++;
    }
    return n;
  }

  // Maximum sequence length that may be moved as one action (supermove rule).
  function maxMovableSequence(s, destCol) {
    var cells = freeCellCount(s);
    var empties = emptyColumnCount(s, typeof destCol === 'number' ? destCol : -1);
    return (cells + 1) * Math.pow(2, empties);
  }

  function isOrderedSequence(col, startIdx) {
    for (var i = startIdx; i < col.length - 1; i++) {
      var a = col[i], b = col[i + 1];
      if (!(rankOf(b) === rankOf(a) - 1 && colorOf(a) !== colorOf(b))) return false;
    }
    return true;
  }

  // May `card` be placed on tableau column `col`?
  function canPlaceOnTableau(s, card, col) {
    var target = s.tableau[col];
    if (target.length === 0) return true; // any card/sequence may take an empty column
    var top = target[target.length - 1];
    return rankOf(card) === rankOf(top) - 1 && colorOf(card) !== colorOf(top);
  }

  function canPlaceOnFoundation(s, card) {
    var f = s.foundations[suitOf(card)];
    return rankOf(card) === f.length + 1;
  }

  // A card is safe to auto-collect when every lower card of the opposite color
  // is already home, so it can never be needed as a tableau landing spot.
  function isSafeForFoundation(s, card) {
    if (!canPlaceOnFoundation(s, card)) return false;
    var r = rankOf(card);
    if (r <= 2) return true;
    var opp = colorOf(card) === 'red' ? [0, 3] : [1, 2];
    return s.foundations[opp[0]].length >= r - 1 && s.foundations[opp[1]].length >= r - 1;
  }

  // ---------------------------------------------------------------- actions
  // Action descriptor:
  // { kind:'move', from:loc, to:loc, count:n }  — n cards from a tableau column
  // { kind:'auto' }                             — collect all safe cards
  // { kind:'concede' }

  function loc(zone, index) { return { zone: zone, index: index }; }

  function sameLoc(a, b) { return a && b && a.zone === b.zone && a.index === b.index; }

  // All legal moves, used by hints, UI highlighting, and tutorials alike.
  function enumerateActions(s) {
    var out = [];
    if (s.status !== 'active') return out;
    var c, i, card;

    // From cells.
    for (i = 0; i < NUM_CELLS; i++) {
      card = s.cells[i];
      if (card === null || i >= s.constraints.cellsAvailable) continue;
      var fromCell = loc('cell', i);
      if (canPlaceOnFoundation(s, card)) out.push({ kind: 'move', from: fromCell, to: loc('foundation', suitOf(card)), count: 1 });
      for (c = 0; c < NUM_COLUMNS; c++) {
        if (canPlaceOnTableau(s, card, c) && s.tableau[c].length > 0) {
          out.push({ kind: 'move', from: fromCell, to: loc('tableau', c), count: 1 });
        }
      }
      // A cell card may also step out to an empty column.
      var e = firstEmptyColumn(s);
      if (e >= 0) out.push({ kind: 'move', from: fromCell, to: loc('tableau', e), count: 1 });
    }

    // From tableau columns.
    for (c = 0; c < NUM_COLUMNS; c++) {
      var col = s.tableau[c];
      if (col.length === 0) continue;
      var top = col[col.length - 1];
      var fromCol = loc('tableau', c);

      // Single top card to a free cell.
      if (freeCellCount(s) > 0) {
        out.push({ kind: 'move', from: fromCol, to: loc('cell', firstFreeCell(s)), count: 1 });
      }
      // Single top card to foundation.
      if (canPlaceOnFoundation(s, top)) {
        out.push({ kind: 'move', from: fromCol, to: loc('foundation', suitOf(top)), count: 1 });
      }
      // Sequences to other columns.
      var runLen = orderedRunLength(col);
      for (var d = 0; d < NUM_COLUMNS; d++) {
        if (d === c) continue;
        var dest = s.tableau[d];
        var cap = maxMovableSequence(s, d);
        if (dest.length === 0) {
          // Whole ordered runs may relocate to an empty column; pointless full-column
          // shuffles (moving the entire column unchanged) are omitted as non-actions.
          var maxN = Math.min(runLen, cap);
          for (var n = 1; n <= maxN; n++) {
            if (n === col.length) continue; // no-op relocation of the whole column
            out.push({ kind: 'move', from: fromCol, to: loc('tableau', d), count: n });
          }
        } else {
          var destTop = dest[dest.length - 1];
          var maxN2 = Math.min(runLen, cap);
          for (var n2 = 1; n2 <= maxN2; n2++) {
            var moving = col[col.length - n2];
            if (rankOf(moving) === rankOf(destTop) - 1 && colorOf(moving) !== colorOf(destTop)) {
              out.push({ kind: 'move', from: fromCol, to: loc('tableau', d), count: n2 });
            }
          }
        }
      }
    }

    // Auto-collect is offered when at least one safe card exists.
    if (!s.constraints.noAuto && findSafeAutoMoves(s).length > 0) out.push({ kind: 'auto' });
    return out;
  }

  function firstFreeCell(s) {
    for (var i = 0; i < Math.min(NUM_CELLS, s.constraints.cellsAvailable); i++) {
      if (s.cells[i] === null) return i;
    }
    return -1;
  }

  function firstEmptyColumn(s) {
    for (var i = 0; i < NUM_COLUMNS; i++) if (s.tableau[i].length === 0) return i;
    return -1;
  }

  // Safe foundation moves, including cascades: collect greedily on a working
  // clone until no further safe card exists. Order is deterministic (cells in
  // index order first, then columns left to right, repeated to a fixpoint).
  function findSafeAutoMoves(s) {
    var moves = [];
    var work = cloneState(s);
    var changed = true;
    var guard = 0;
    while (changed && guard++ < DECK_SIZE + 1) {
      changed = false;
      var i, card;
      for (i = 0; i < NUM_CELLS; i++) {
        card = work.cells[i];
        if (card !== null && isSafeForFoundation(work, card)) {
          moves.push({ kind: 'move', from: loc('cell', i), to: loc('foundation', suitOf(card)), count: 1 });
          work.cells[i] = null;
          work.foundations[suitOf(card)].push(card);
          changed = true;
        }
      }
      for (i = 0; i < NUM_COLUMNS; i++) {
        card = topOfColumn(work, i);
        if (card !== null && isSafeForFoundation(work, card)) {
          moves.push({ kind: 'move', from: loc('tableau', i), to: loc('foundation', suitOf(card)), count: 1 });
          work.tableau[i].pop();
          work.foundations[suitOf(card)].push(card);
          changed = true;
        }
      }
    }
    return moves;
  }

  // ---------------------------------------------------------------- validation

  // Returns { ok:true, action } or { ok:false, reason }. Never mutates.
  function validateMove(s, from, to, count) {
    count = count || 1;
    if (s.status !== 'active') return fail('game-over', 'The deal is already ' + s.status + '.');
    if (!from || !to) return fail('bad-location', 'Missing source or target.');
    if (!Number.isInteger(count) || count < 1) return fail('bad-count', 'Nothing to move.');
    if (sameLoc(from, to)) return fail('same-location', 'That is the same place.');

    var cards = pickCards(s, from, count);
    if (!cards.ok) return cards;
    var moving = cards.cards;
    var head = moving[0];

    if (to.zone === 'cell') {
      if (moving.length > 1) return fail('cell-single', 'A cell holds exactly one card.');
      if (to.index < 0 || to.index >= NUM_CELLS || to.index >= s.constraints.cellsAvailable) {
        return fail('cell-unavailable', 'That cell is not available in this deal.');
      }
      if (s.cells[to.index] !== null) return fail('cell-occupied', 'That cell is occupied.');
      return ok();
    }

    if (to.zone === 'foundation') {
      if (moving.length > 1) return fail('foundation-single', 'Foundations take one card at a time.');
      if (to.index < 0 || to.index >= NUM_SUITS) return fail('bad-location', 'No such foundation.');
      if (suitOf(head) !== to.index) return fail('foundation-suit', 'Cards build on their own suit.');
      if (rankOf(head) !== s.foundations[to.index].length + 1) {
        return fail('foundation-order', 'Foundations build upward from the ace.');
      }
      return ok();
    }

    if (to.zone === 'tableau') {
      if (to.index < 0 || to.index >= NUM_COLUMNS) return fail('bad-location', 'No such column.');
      if (from.zone === 'tableau' && from.index === to.index) return fail('same-location', 'That is the same column.');
      if (moving.length > 1 && !isOrderedSequence(moving, 0)) {
        return fail('sequence-broken', 'Only descending, alternating runs move together.');
      }
      var dest = s.tableau[to.index];
      if (moving.length > 1) {
        var cap = maxMovableSequence(s, to.index);
        if (moving.length > cap) {
          return fail('sequence-too-long', 'Not enough free cells to move ' + moving.length + ' cards (max ' + cap + ').');
        }
      }
      if (dest.length === 0) {
        if (from.zone === 'tableau' && moving.length === s.tableau[from.index].length) {
          return fail('pointless-move', 'That just moves the whole column to an empty space.');
        }
        return ok();
      }
      var top = dest[dest.length - 1];
      if (!(rankOf(head) === rankOf(top) - 1 && colorOf(head) !== colorOf(top))) {
        return fail('tableau-order', 'Columns build downward in alternating colors.');
      }
      return ok();
    }

    return fail('bad-location', 'Unknown target.');
  }

  function pickCards(s, from, count) {
    if (from.zone === 'cell') {
      if (from.index < 0 || from.index >= NUM_CELLS) return fail('bad-location', 'No such cell.');
      if (s.cells[from.index] === null) return fail('empty-source', 'That cell is empty.');
      if (count !== 1) return fail('cell-single', 'A cell holds exactly one card.');
      return { ok: true, cards: [s.cells[from.index]] };
    }
    if (from.zone === 'tableau') {
      if (from.index < 0 || from.index >= NUM_COLUMNS) return fail('bad-location', 'No such column.');
      var col = s.tableau[from.index];
      if (col.length === 0) return fail('empty-source', 'That column is empty.');
      if (count > col.length) return fail('bad-count', 'Not enough cards in that column.');
      return { ok: true, cards: col.slice(col.length - count) };
    }
    if (from.zone === 'foundation') {
      // Pulling back off a foundation is allowed in practice (undo-friendly ruleset).
      if (from.index < 0 || from.index >= NUM_SUITS) return fail('bad-location', 'No such foundation.');
      var f = s.foundations[from.index];
      if (f.length === 0) return fail('empty-source', 'That foundation is empty.');
      if (count !== 1) return fail('foundation-single', 'Foundations give one card at a time.');
      return { ok: true, cards: [f[f.length - 1]] };
    }
    return fail('bad-location', 'Unknown source.');
  }

  function ok() { return { ok: true }; }
  function fail(reason, message) { return { ok: false, reason: reason, message: message }; }

  // ---------------------------------------------------------------- application

  // Apply a validated command; returns a NEW state. On invalid input returns
  // a new state with `invalid` incremented and turn bumped (deterministic).
  function applyCommand(s, cmd) {
    var next = cloneState(s);
    if (cmd && cmd.type === 'tick') {
      // Authoritative time advance; integer milliseconds only. Ticks carry
      // wall-clock data, so they do not consume a turn (replay logs omit them).
      var dt = Math.max(0, Math.floor(cmd.elapsedMs || 0));
      if (dt !== dt) dt = 0; // NaN guard
      next.elapsedMs += dt;
      updateTerminal(next);
      return next;
    }
    next.turn += 1;
    if (!cmd || typeof cmd !== 'object') {
      next.invalid += 1;
      return next;
    }
    if (cmd.type === 'move') {
      var v = validateMove(s, cmd.from, cmd.to, cmd.count || 1);
      if (!v.ok) {
        next.invalid += 1;
        return next;
      }
      doMove(next, cmd.from, cmd.to, cmd.count || 1);
      next.moves += 1;
    } else if (cmd.type === 'auto') {
      if (s.constraints.noAuto) { next.invalid += 1; return next; }
      var moves = findSafeAutoMoves(s);
      if (moves.length === 0) { next.invalid += 1; return next; }
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        var vv = validateMove(next, m.from, m.to, 1);
        if (vv.ok) { doMove(next, m.from, m.to, 1); next.moves += 1; }
      }
    } else if (cmd.type === 'concede') {
      next.status = 'lost';
      next.terminalReason = 'conceded';
      return next;
    } else if (cmd.type === 'undo') {
      // Undo is resolved by the session layer (it owns snapshots); the rules
      // engine only records that one happened so scoring stays honest.
      next.undos += 1;
    } else {
      next.invalid += 1;
      return next;
    }
    updateTerminal(next);
    return next;
  }

  function doMove(s, from, to, count) {
    var cards;
    if (from.zone === 'cell') { cards = [s.cells[from.index]]; s.cells[from.index] = null; }
    else if (from.zone === 'foundation') { cards = [s.foundations[from.index].pop()]; }
    else { cards = s.tableau[from.index].splice(s.tableau[from.index].length - count, count); }

    if (to.zone === 'cell') s.cells[to.index] = cards[0];
    else if (to.zone === 'foundation') s.foundations[to.index].push(cards[0]);
    else for (var i = 0; i < cards.length; i++) s.tableau[to.index].push(cards[i]);
  }

  function updateTerminal(s) {
    if (s.status !== 'active') return;
    var home = 0;
    for (var i = 0; i < NUM_SUITS; i++) home += s.foundations[i].length;
    if (home === DECK_SIZE) {
      s.status = 'won';
      s.terminalReason = 'all-foundations-complete';
      return;
    }
    if (Number.isInteger(s.constraints.moveLimit) && s.moves >= s.constraints.moveLimit) {
      s.status = 'lost';
      s.terminalReason = 'move-limit-exceeded';
      return;
    }
    if (Number.isInteger(s.constraints.timeLimitMs) && s.elapsedMs >= s.constraints.timeLimitMs) {
      s.status = 'lost';
      s.terminalReason = 'time-limit-exceeded';
    }
  }

  // ---------------------------------------------------------------- scoring

  // Component breakdown, integers only. Presentation formats; rules computes.
  function scoreBreakdown(s, par) {
    par = par || {};
    var home = 0;
    for (var i = 0; i < NUM_SUITS; i++) home += s.foundations[i].length;
    var won = s.status === 'won';
    var completion = home * 100;
    var winBonus = won ? 5000 : 0;
    var parMoves = Number.isInteger(par.moves) ? par.moves : 120;
    var efficiency = won ? Math.max(0, (parMoves - s.moves)) * 25 : 0;
    var parTimeMs = Number.isInteger(par.timeMs) ? par.timeMs : 300000;
    var timeBonus = won ? Math.max(0, Math.floor((parTimeMs - s.elapsedMs) / 1000)) * 2 : 0;
    var invalidPenalty = -s.invalid * 10;
    var undoPenalty = -s.undos * 5;
    var total = completion + winBonus + efficiency + timeBonus + invalidPenalty + undoPenalty;
    return {
      completion: completion,
      winBonus: winBonus,
      efficiency: efficiency,
      timeBonus: timeBonus,
      invalidPenalty: invalidPenalty,
      undoPenalty: undoPenalty,
      total: total
    };
  }

  // Tie-break ordering: completion, fewer invalid, lower elapsed, stable id.
  function compareResults(a, b) {
    if (b.score.completion !== a.score.completion) return b.score.completion - a.score.completion;
    if (a.invalid !== b.invalid) return a.invalid - b.invalid;
    if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
    return String(a.sessionId).localeCompare(String(b.sessionId));
  }

  // Hint ranking: prefer foundation moves, then productive tableau moves,
  // then emptying columns, and only then parking a card in a cell.
  function rankHints(s) {
    var actions = enumerateActions(s).filter(function (a) { return a.kind === 'move'; });
    function score(a) {
      if (a.to.zone === 'foundation') return 100;
      if (a.to.zone === 'tableau' && s.tableau[a.to.index].length > 0) return 50 + a.count;
      if (a.to.zone === 'tableau') return 30 + a.count;
      return 10; // parking in a cell
    }
    return actions.sort(function (a, b) { return score(b) - score(a); });
  }

  return {
    VERSION: VERSION,
    NUM_CELLS: NUM_CELLS,
    NUM_SUITS: NUM_SUITS,
    NUM_COLUMNS: NUM_COLUMNS,
    DECK_SIZE: DECK_SIZE,
    SUIT_NAMES: SUIT_NAMES,
    SUIT_SYMBOLS: SUIT_SYMBOLS,
    RANK_LABELS: RANK_LABELS,
    suitOf: suitOf,
    rankOf: rankOf,
    colorOf: colorOf,
    cardLabel: cardLabel,
    isValidCard: isValidCard,
    makeRng: makeRng,
    hashString: hashString,
    deal: deal,
    createState: createState,
    cloneState: cloneState,
    serialize: serialize,
    deserialize: deserialize,
    validateStateShape: validateStateShape,
    stateHash: stateHash,
    topOfColumn: topOfColumn,
    orderedRunLength: orderedRunLength,
    freeCellCount: freeCellCount,
    emptyColumnCount: emptyColumnCount,
    maxMovableSequence: maxMovableSequence,
    isOrderedSequence: isOrderedSequence,
    canPlaceOnTableau: canPlaceOnTableau,
    canPlaceOnFoundation: canPlaceOnFoundation,
    isSafeForFoundation: isSafeForFoundation,
    enumerateActions: enumerateActions,
    findSafeAutoMoves: findSafeAutoMoves,
    validateMove: validateMove,
    applyCommand: applyCommand,
    updateTerminal: updateTerminal,
    scoreBreakdown: scoreBreakdown,
    compareResults: compareResults,
    rankHints: rankHints
  };
});
