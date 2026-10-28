'use strict';
/* The save document, local boards and options (src/store.js), as the engine
 * client keeps them: merges keep every completion, best and unlock; the
 * browser build's cloud slot reads; option values are validated. */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/store.js');

const entry = (id, total, extra) => Object.assign({ board: 'daily', dealId: 'daily-x', seed: 1, ruleset: 'open-cells/1', contentVersion: 1,
  score: { total }, assists: { undo: 0, hints: 0 }, durationMs: 1000, moves: 90, invalid: 0, sessionId: id, at: '2026-01-01' }, extra || {});

test('normalize fills an empty document', () => {
  const d = S.normalize(null);
  assert.equal(d.save.version, 1);
  assert.deepEqual(d.boards, { boards: {} });
  assert.deepEqual(d.save.totals, { foundations: 0, wins: 0, played: 0 });
});

test('mergeData keeps both sides\' progress and this device\'s deal', () => {
  const a = S.normalize(null), b = S.normalize(null);
  a.save.journey['journey-01'] = { stars: 2, bestScore: 9000, bestMoves: 120, completedAt: '2026-01-02' };
  b.save.journey['journey-01'] = { stars: 3, bestScore: 8000, bestMoves: 110, completedAt: '2026-01-01' };
  b.save.journey['journey-02'] = { stars: 1, bestScore: 7000, bestMoves: 140, completedAt: '2026-01-03' };
  a.save.lessons['learn-cells'] = { completedAt: '2026-01-01' };
  b.save.achievements['first-completion'] = '2026-01-01';
  a.save.totals = { foundations: 100, wins: 2, played: 5 };
  b.save.totals = { foundations: 50, wins: 3, played: 4 };
  a.save.lastSnapshot = { config: { dealId: 'mine' } };
  b.save.lastSnapshot = { config: { dealId: 'theirs' } };
  a.boards = S.addEntry(a.boards, entry('s1', 900));
  b.boards = S.addEntry(b.boards, entry('s2', 1200));
  b.boards = S.addEntry(b.boards, entry('s1', 900));
  const m = S.mergeData(a, b);
  assert.deepEqual(m.save.journey['journey-01'], { stars: 3, bestScore: 9000, bestMoves: 110, completedAt: '2026-01-01' });
  assert.ok(m.save.journey['journey-02']);
  assert.ok(m.save.lessons['learn-cells']);
  assert.equal(m.save.achievements['first-completion'], '2026-01-01');
  assert.deepEqual(m.save.totals, { foundations: 100, wins: 3, played: 5 });
  assert.equal(m.save.lastSnapshot.config.dealId, 'mine');
  assert.deepEqual(m.boards.boards.daily.map((e) => e.sessionId), ['s2', 's1']);
  assert.ok(S.same(m, S.mergeData(m, a)));
});

test('the daily streak follows the later day', () => {
  const a = S.normalize(null), b = S.normalize(null);
  a.save.dailyStreak = { count: 2, lastDate: '2026-01-02' };
  b.save.dailyStreak = { count: 5, lastDate: '2025-12-30' };
  assert.deepEqual(S.mergeData(a, b).save.dailyStreak, { count: 2, lastDate: '2026-01-02' });
});

test('readForeign reads the browser build\'s cloud slot (wrapper or bare save)', () => {
  const save = S.emptySave();
  save.journey['journey-03'] = { stars: 1, bestScore: 1, bestMoves: 1, completedAt: 'x' };
  const wrapped = JSON.stringify({ kind: 'open-cells/cloud/v1', savedAt: 'x', save, boards: { boards: { chase: [entry('c1', 50, { board: 'chase' })] } } });
  const d = S.readForeign(wrapped);
  assert.ok(d.save.journey['journey-03']);
  assert.equal(d.boards.boards.chase.length, 1);
  assert.ok(S.readForeign(JSON.stringify(save)).save.journey['journey-03']);
  assert.equal(S.readForeign('not json'), null);
  assert.equal(S.readForeign(''), null);
});

test('addEntry keeps the best 50, drops the replay copy', () => {
  let b = S.normalize(null).boards;
  for (let i = 0; i < 60; i++) b = S.addEntry(b, entry('s' + i, i, { replay: { big: true } }));
  assert.equal(b.boards.daily.length, 50);
  assert.equal(b.boards.daily[0].score.total, 59);
  assert.equal(b.boards.daily[0].replay, undefined);
});

test('pickOptions keeps only valid option values', () => {
  assert.deepEqual(S.pickOptions({ theme: 'verdigris', colorPalette: 'tritanopia', leftHanded: true, haptics: 'yes', theme2: 1 }),
    { theme: 'verdigris', colorPalette: 'tritanopia', leftHanded: true });
  assert.deepEqual(S.pickOptions({ theme: 'nope', colorPalette: 'default' }), {});
  assert.ok(S.BROWSER_KEYS.includes('volume') && S.BROWSER_KEYS.includes('ui.language'));
});
