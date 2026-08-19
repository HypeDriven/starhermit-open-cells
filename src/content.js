/*
 * Open Cells — content: versioned lessons, journey stages, daily deals,
 * challenge definitions, themes, and achievements. Pure data + small helpers.
 * Browser: window.OCContent (requires OCRules). Node: module.exports.
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else global.OCContent = factory(global.OCRules);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  var CONTENT_VERSION = 1;

  // ---------------------------------------------------------------- helpers

  // Build a full-deck state from a list of "focus" columns. Each focus entry is
  // an array of card ids placed on TOP of the column (bottom-to-top order).
  // Remaining cards are distributed underneath, round-robin, so every lesson
  // state stays a valid 52-card position.
  function buildLessonTableau(focus) {
    var used = new Set();
    var i, j;
    for (i = 0; i < focus.length; i++) if (focus[i]) for (j = 0; j < focus[i].length; j++) used.add(focus[i][j]);
    var rest = [];
    for (i = 0; i < R.DECK_SIZE; i++) if (!used.has(i)) rest.push(i);
    var tableau = [];
    for (i = 0; i < R.NUM_COLUMNS; i++) tableau.push([]);
    // Spread distractors only across columns with no focus, so focus cards stay on top.
    var sink = [];
    for (i = 0; i < R.NUM_COLUMNS; i++) if (!focus[i] || focus[i].length === 0) sink.push(i);
    if (sink.length === 0) sink = [0];
    var k = 0;
    for (i = 0; i < rest.length; i++) { tableau[sink[k]].push(rest[i]); k = (k + 1) % sink.length; }
    for (i = 0; i < focus.length; i++) if (focus[i]) for (j = 0; j < focus[i].length; j++) tableau[i].push(focus[i][j]);
    return tableau;
  }

  // Card id shorthand: c('S',13) -> king of spades. Suits S H D C, ranks 1..13.
  var SUIT_IDX = { S: 0, H: 1, D: 2, C: 3 };
  function c(suit, rank) { return SUIT_IDX[suit] * 13 + (rank - 1); }

  // ---------------------------------------------------------------- lessons
  // A lesson step may require the player to perform an action before advancing.
  // `require` is a predicate name checked by the session layer against each
  // applied command — lessons share the same legal-action path as real play.

  var LESSONS = [
    {
      id: 'learn-tableau', title: 'Build Down the Tableau', version: 1,
      intro: 'Eight columns hold the whole deck, face up. Columns build downward in alternating colors.',
      setup: function () {
        return buildLessonTableau([null, null, [c('H', 7)], [c('S', 6)], null, null, null, null]);
      },
      steps: [
        { text: 'The six of spades can land on the seven of hearts — one rank lower, opposite color.', require: null },
        { text: 'Move the 6♠ onto the 7♥. Drag it, or select it and then select the target.', require: 'move-to-tableau' }
      ]
    },
    {
      id: 'learn-cells', title: 'The Four Temporary Cells', version: 1,
      intro: 'Cells are short-term parking. Each holds exactly one card.',
      setup: function () {
        return buildLessonTableau([null, null, [c('D', 9)], [c('S', 10)], null, null, null, null]);
      },
      steps: [
        { text: 'Park the 9♦ in any free cell.', require: 'move-to-cell' },
        { text: 'Now bring it back out — onto the 10♠, where it belongs.', require: 'move-from-cell' }
      ]
    },
    {
      id: 'learn-foundations', title: 'Raising the Foundations', version: 1,
      intro: 'Four foundations, one per suit, build upward from ace to king. Fill all four to win.',
      setup: function () {
        return buildLessonTableau([[c('S', 1)], [c('S', 2)], null, null, null, null, null, null]);
      },
      steps: [
        { text: 'Send the A♠ home to its foundation.', require: 'move-to-foundation' },
        { text: 'Now the 2♠ follows its ace.', require: 'move-to-foundation' }
      ]
    },
    {
      id: 'learn-sequences', title: 'Moving Sequences', version: 1,
      intro: 'A descending, alternating run at the bottom of a column can travel as one move.',
      setup: function () {
        return buildLessonTableau([null, null, [c('S', 9)], [c('D', 8), c('C', 7)], null, null, null, null]);
      },
      steps: [
        { text: 'The 8♦–7♣ run is ordered. The 9♠ is a legal landing.', require: null },
        { text: 'Move BOTH cards together onto the 9♠ — drag the 8♦, the run follows.', require: 'move-sequence' }
      ]
    },
    {
      id: 'learn-supermove', title: 'Supermoves and Capacity', version: 1,
      intro: 'How long a run you may move depends on working room: (free cells + 1) × 2^(empty columns).',
      setup: function () {
        return buildLessonTableau([null, null, [c('H', 10)], [c('S', 9), c('H', 8), c('S', 7)], null, null, null, null]);
      },
      steps: [
        { text: 'With four cells free you can shift up to five cards at once — here a three-card run.', require: null },
        { text: 'Move the 9♠–8♥–7♠ run onto the 10♥.', require: 'move-sequence' }
      ]
    },
    {
      id: 'learn-finish', title: 'Collecting and Winning', version: 1,
      intro: 'When every lower opposite-color card is home, a card is safe — the desk can collect such cards for you.',
      setup: function () {
        return buildLessonTableau([[c('S', 1)], [c('H', 1)], [c('D', 1)], [c('C', 1)], [c('S', 2)], [c('H', 2)], [c('D', 2)], [c('C', 2)]]);
      },
      steps: [
        { text: 'All four aces and twos are exposed and safe.', require: null },
        { text: 'Use Collect (the auto action) to sweep every safe card home.', require: 'auto' }
      ]
    }
  ];

  // ---------------------------------------------------------------- journey
  // 40 authored stages. Seeds are fixed at authoring time and validated offline
  // (tools/validate.js). Difficulty ramps through par tightening, then through
  // constraint mechanics introduced one at a time. Every 10th stage is a
  // mastery check that combines what came before.

  function stage(n, title, opts) {
    opts = opts || {};
    return Object.assign({
      id: 'journey-' + String(n).padStart(2, '0'),
      n: n,
      title: title,
      version: 1,
      seed: R.hashString('open-cells/journey/' + n),
      constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: false },
      par: { moves: 130, timeMs: 420000 },
      difficulty: 1,
      mastery: false,
      theme: 'brass-slate',
      tutorialFlags: []
    }, opts);
  }

  var JOURNEY = [
    // Arc 1 — open ground: generous pars, learn the desk.
    stage(1, 'First Light', { seed: 2581588807, par: { moves: 160, timeMs: 600000 }, difficulty: 1 }),
    stage(2, 'Open Drawers', { seed: 3911271869, par: { moves: 155, timeMs: 570000 }, difficulty: 1 }),
    stage(3, 'Brass Edges', { par: { moves: 150, timeMs: 540000 }, difficulty: 1 }),
    stage(4, 'Quiet Sorting', { par: { moves: 145, timeMs: 510000 }, difficulty: 2 }),
    stage(5, 'Cell Discipline', { seed: 150834347, par: { moves: 140, timeMs: 480000 }, difficulty: 2, tutorialFlags: ['cells'] }),
    stage(6, 'Long Runs', { par: { moves: 138, timeMs: 470000 }, difficulty: 2 }),
    stage(7, 'Empty Ground', { seed: 2469160457, par: { moves: 135, timeMs: 460000 }, difficulty: 2, tutorialFlags: ['empty-columns'] }),
    stage(8, 'Slate Patience', { par: { moves: 132, timeMs: 450000 }, difficulty: 2 }),
    stage(9, 'Steady Hands', { par: { moves: 130, timeMs: 440000 }, difficulty: 2 }),
    stage(10, 'Mastery: The Open Desk', { par: { moves: 125, timeMs: 420000 }, difficulty: 3, mastery: true }),
    // Arc 2 — the clock joins in: time targets appear, pars tighten.
    stage(11, 'Measured Pace', { seed: 2946189220, par: { moves: 125, timeMs: 400000 }, difficulty: 3 }),
    stage(12, 'Ticking Brass', { par: { moves: 124, timeMs: 380000 }, difficulty: 3, constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: 600000, noAuto: false } }),
    stage(13, 'Short Fuses', { par: { moves: 122, timeMs: 370000 }, difficulty: 3, constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: 560000, noAuto: false } }),
    stage(14, 'Clean Lines', { seed: 3689023639, par: { moves: 120, timeMs: 360000 }, difficulty: 3 }),
    stage(15, 'Half Drawer', { par: { moves: 128, timeMs: 380000 }, difficulty: 3, constraints: { cellsAvailable: 3, moveLimit: null, timeLimitMs: null, noAuto: false } }),
    stage(16, 'Three Slots', { seed: 530547308, par: { moves: 126, timeMs: 380000 }, difficulty: 4, constraints: { cellsAvailable: 3, moveLimit: null, timeLimitMs: null, noAuto: false } }),
    stage(17, 'Narrow Margin', { par: { moves: 124, timeMs: 370000 }, difficulty: 4, constraints: { cellsAvailable: 3, moveLimit: null, timeLimitMs: null, noAuto: false } }),
    stage(18, 'Weight of Brass', { seed: 897777664, par: { moves: 122, timeMs: 360000 }, difficulty: 4 }),
    stage(19, 'Low Light', { par: { moves: 120, timeMs: 350000 }, difficulty: 4 }),
    stage(20, 'Mastery: Three Cells, Full Clock', { seed: 146427643, par: { moves: 125, timeMs: 330000 }, difficulty: 4, mastery: true, constraints: { cellsAvailable: 3, moveLimit: null, timeLimitMs: 480000, noAuto: false } }),
    // Arc 3 — economy: move limits and no auto-collect.
    stage(21, 'Count Every Step', { seed: 774781155, par: { moves: 118, timeMs: 340000 }, difficulty: 4, constraints: { cellsAvailable: 4, moveLimit: 160, timeLimitMs: null, noAuto: false } }),
    stage(22, 'Fewer Words', { seed: 3662759651, par: { moves: 116, timeMs: 340000 }, difficulty: 4, constraints: { cellsAvailable: 4, moveLimit: 170, timeLimitMs: null, noAuto: false } }),
    stage(23, 'No Assistance', { par: { moves: 118, timeMs: 350000 }, difficulty: 4, constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: true } }),
    stage(24, 'By Hand Alone', { par: { moves: 116, timeMs: 340000 }, difficulty: 4, constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: true } }),
    stage(25, 'Exact Change', { seed: 2257527092, par: { moves: 114, timeMs: 340000 }, difficulty: 5, constraints: { cellsAvailable: 4, moveLimit: 145, timeLimitMs: null, noAuto: true } }),
    stage(26, 'Tight Corners', { seed: 4022175567, par: { moves: 114, timeMs: 330000 }, difficulty: 5, constraints: { cellsAvailable: 3, moveLimit: 150, timeLimitMs: null, noAuto: false } }),
    stage(27, 'Brass Pressure', { seed: 4695630, par: { moves: 112, timeMs: 330000 }, difficulty: 5, constraints: { cellsAvailable: 3, moveLimit: 165, timeLimitMs: 520000, noAuto: false } }),
    stage(28, 'Silent Desk', { par: { moves: 112, timeMs: 330000 }, difficulty: 5, constraints: { cellsAvailable: 3, timeLimitMs: null, noAuto: true } }),
    stage(29, 'Thin Ice', { seed: 2691801020, par: { moves: 112, timeMs: 320000 }, difficulty: 5, constraints: { cellsAvailable: 3, moveLimit: 160, timeLimitMs: 500000, noAuto: true } }),
    stage(30, 'Mastery: The Strict Ledger', { seed: 2834935794, par: { moves: 115, timeMs: 300000 }, difficulty: 5, mastery: true, constraints: { cellsAvailable: 3, timeLimitMs: 480000, noAuto: true } }),
    // Arc 4 — mastery track: combined constraints, two-cell finales.
    stage(31, 'Two Drawers', { seed: 2560986131, par: { moves: 118, timeMs: 330000 }, difficulty: 5, constraints: { cellsAvailable: 2, moveLimit: null, timeLimitMs: null, noAuto: false } }),
    stage(32, 'Cramped Quarters', { par: { moves: 116, timeMs: 330000 }, difficulty: 5, constraints: { cellsAvailable: 2, moveLimit: null, timeLimitMs: 540000, noAuto: false } }),
    stage(33, 'Double Bind', { seed: 3723383718, par: { moves: 116, timeMs: 320000 }, difficulty: 5, constraints: { cellsAvailable: 2, moveLimit: 170, timeLimitMs: null, noAuto: true } }),
    stage(34, 'Narrow Passage', { seed: 2692697134, par: { moves: 114, timeMs: 320000 }, difficulty: 5, constraints: { cellsAvailable: 2, moveLimit: 165, timeLimitMs: 520000, noAuto: false } }),
    stage(35, 'The Long Night', { seed: 1719783124, par: { moves: 114, timeMs: 310000 }, difficulty: 5, constraints: { cellsAvailable: 2, timeLimitMs: 500000, noAuto: true } }),
    stage(36, 'Clockwork', { par: { moves: 112, timeMs: 300000 }, difficulty: 5, constraints: { cellsAvailable: 3, timeLimitMs: 420000, noAuto: true } }),
    stage(37, 'Perfect Order', { seed: 2266648069, par: { moves: 112, timeMs: 300000 }, difficulty: 5, constraints: { cellsAvailable: 3, moveLimit: 135, timeLimitMs: 400000, noAuto: true } }),
    stage(38, 'Slate and Ash', { seed: 1991602785, par: { moves: 110, timeMs: 300000 }, difficulty: 5, constraints: { cellsAvailable: 2, moveLimit: 160, timeLimitMs: 480000, noAuto: true } }),
    stage(39, 'The Quiet Ledger', { seed: 1609488964, par: { moves: 110, timeMs: 290000 }, difficulty: 5, constraints: { cellsAvailable: 2, moveLimit: 155, timeLimitMs: 460000, noAuto: true } }),
    stage(40, 'Mastery: The Brass Ordeal', { seed: 875974987, par: { moves: 115, timeMs: 280000 }, difficulty: 5, mastery: true, constraints: { cellsAvailable: 2, moveLimit: 160, timeLimitMs: 450000, noAuto: true } })
  ];

  // ---------------------------------------------------------------- daily
  // One immutable deal per UTC day. The seed derives only from the date string.

  function dailyInfo(date) {
    var d = date || new Date();
    var iso = d.toISOString().slice(0, 10); // UTC calendar day
    return {
      id: 'daily-' + iso,
      date: iso,
      version: CONTENT_VERSION,
      seed: R.hashString('open-cells/daily/' + iso),
      constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: false },
      par: { moves: 120, timeMs: 360000 },
      ruleset: 'open-cells/1'
    };
  }

  function msUntilNextUtcDay(now) {
    var d = now || new Date();
    var next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
    return next - d.getTime();
  }

  // ---------------------------------------------------------------- challenges
  // Rotating constrained deals. `seedOffset` lets the player reroll while the
  // ruleset stays fixed.

  var CHALLENGES = [
    { id: 'chal-two-cells', title: 'Two Drawers', version: 1, difficulty: 4, seed: 3581388901, description: 'Only two cells are open. Plan further ahead.', constraints: { cellsAvailable: 2, moveLimit: null, timeLimitMs: null, noAuto: false }, par: { moves: 120, timeMs: 360000 } },
    { id: 'chal-strict-ledger', title: 'The Strict Ledger', version: 1, difficulty: 4, seed: null, description: 'Three cells, no auto-collect. Every move by hand, and count it.', constraints: { cellsAvailable: 3, moveLimit: null, timeLimitMs: null, noAuto: true }, par: { moves: 115, timeMs: 360000 } },
    { id: 'chal-brass-clock', title: 'The Brass Clock', version: 1, difficulty: 3, seed: 1387139296, description: 'Win before eight minutes run out.', constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: 480000, noAuto: false }, par: { moves: 120, timeMs: 300000 } },
    { id: 'chal-bare-hands', title: 'Bare Hands', version: 1, difficulty: 3, seed: null, description: 'No auto-collect. Every card by hand.', constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: true }, par: { moves: 125, timeMs: 420000 } },
    { id: 'chal-cramped', title: 'Cramped and Counted', version: 1, difficulty: 5, seed: 1553039238, description: 'Two cells, 185 moves, no assistance.', constraints: { cellsAvailable: 2, moveLimit: 185, timeLimitMs: null, noAuto: true }, par: { moves: 115, timeMs: 420000 } },
    { id: 'chal-ordeal', title: 'The Brass Ordeal', version: 1, difficulty: 5, seed: 3671125273, description: 'Two cells, a clock, a ledger, no help.', constraints: { cellsAvailable: 2, moveLimit: 160, timeLimitMs: 450000, noAuto: true }, par: { moves: 115, timeMs: 300000 } }
  ];

  // Challenge seed: explicit override if present (baked-in, solver-validated),
  // otherwise derived from the challenge id.
  function challengeSeed(ch) {
    return ch.seed != null ? ch.seed : R.hashString('open-cells/challenge/' + ch.id);
  }

  // ---------------------------------------------------------------- practice

  var PRACTICE_DIFFICULTIES = [
    { id: 'relaxed', title: 'Relaxed', description: 'Full cells, auto-collect on, undo free. Unranked.', constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: false } },
    { id: 'standard', title: 'Standard', description: 'The classic desk. Unranked.', constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: false } },
    { id: 'strict', title: 'Strict', description: 'Three cells, no auto-collect. Unranked.', constraints: { cellsAvailable: 3, moveLimit: null, timeLimitMs: null, noAuto: true } }
  ];

  // ---------------------------------------------------------------- themes

  var THEMES = [
    {
      id: 'brass-slate', name: 'Brass & Slate', version: 1,
      desk: '#2b3138', deskTrim: '#b08d3e', cloth: '#31404a', slot: '#232a31',
      cardFace: '#f4efe4', cardBack: '#8a6d2f', accent: '#d8b04c',
      suitRed: '#a63a3a', suitBlack: '#26282e', text: '#e8e2d2'
    },
    {
      id: 'verdigris', name: 'Verdigris', version: 1,
      desk: '#25332f', deskTrim: '#7ba88f', cloth: '#2c3f38', slot: '#1d2825',
      cardFace: '#f0f2e8', cardBack: '#4a6b5c', accent: '#9fc7ae',
      suitRed: '#b0483e', suitBlack: '#22302b', text: '#e2ecdf'
    },
    {
      id: 'night-ink', name: 'Night Ink', version: 1,
      desk: '#1c2030', deskTrim: '#6d7bb0', cloth: '#232a40', slot: '#161a28',
      cardFace: '#e8e9f2', cardBack: '#3d4670', accent: '#8fa2e0',
      suitRed: '#c05a6e', suitBlack: '#20263c', text: '#dfe2f0'
    },
    {
      id: 'parchment', name: 'Parchment', version: 1,
      desk: '#6b5b41', deskTrim: '#8a734f', cloth: '#7d6c4e', slot: '#54472f',
      cardFace: '#faf5e6', cardBack: '#97753f', accent: '#f0d493',
      suitRed: '#9c3b30', suitBlack: '#33291c', text: '#2e2417'
    },
    {
      id: 'contrast', name: 'High Contrast', version: 1,
      desk: '#000000', deskTrim: '#ffffff', cloth: '#101010', slot: '#000000',
      cardFace: '#ffffff', cardBack: '#303030', accent: '#ffdd00',
      suitRed: '#ff5a00', suitBlack: '#000000', text: '#ffffff'
    }
  ];

  // ---------------------------------------------------------------- achievements
  // Stable lowercase keys; unlocks are idempotent and recorded with timestamps.

  var ACHIEVEMENTS = [
    { key: 'first-completion', title: 'First Foundations', description: 'Win your first deal.' },
    { key: 'mechanic-mastery', title: 'Desk Mechanic', description: 'Finish every Learn lesson.' },
    { key: 'daily-streak-3', title: 'Three Dawns', description: 'Win the daily deal on three consecutive UTC days.' },
    { key: 'journey-milestone-30', title: 'Deep in the Ledger', description: 'Complete Journey stage 30.' },
    { key: 'long-game', title: 'The Long Game', description: 'Collect 2,600 cards to foundations across all play.' }
  ];

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    LESSONS: LESSONS,
    JOURNEY: JOURNEY,
    CHALLENGES: CHALLENGES,
    PRACTICE_DIFFICULTIES: PRACTICE_DIFFICULTIES,
    THEMES: THEMES,
    ACHIEVEMENTS: ACHIEVEMENTS,
    dailyInfo: dailyInfo,
    challengeSeed: challengeSeed,
    msUntilNextUtcDay: msUntilNextUtcDay,
    buildLessonTableau: buildLessonTableau,
    cardId: c
  };
});
