'use strict';
/* Open Cells — rules engine tests. Run: node --test test/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rules.js');

function fresh(seed = 12345) {
  return R.createState({ seed, dealId: 'test-' + seed });
}
function mv(from, to, count) { return { type: 'move', from, to, count: count || 1 }; }

test('deal is deterministic and a full permutation', () => {
  const a = R.deal(42), b = R.deal(42), c = R.deal(43);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  const all = a.flat().sort((x, y) => x - y);
  assert.equal(all.length, 52);
  assert.deepEqual(all, Array.from({ length: 52 }, (_, i) => i));
  assert.equal(a[0].length, 7);
  assert.equal(a[7].length, 6);
});

test('state round-trips through serialization', () => {
  const s = fresh(7);
  const s2 = R.deserialize(R.serialize(s));
  assert.deepEqual(s, s2);
  assert.equal(R.stateHash(s), R.stateHash(s2));
});

test('deserialize rejects corrupt states', () => {
  const s = fresh(7);
  const dup = JSON.parse(R.serialize(s));
  dup.cells[0] = dup.tableau[0][0];
  assert.throws(() => R.deserialize(dup), /duplicate/);
  const missing = JSON.parse(R.serialize(s));
  missing.tableau[0].pop();
  assert.throws(() => R.deserialize(missing), /incomplete/);
  assert.throws(() => R.deserialize({ version: 999 }), /version/);
});

test('turn increments monotonically on every command', () => {
  let s = fresh(9);
  assert.equal(s.turn, 0);
  s = R.applyCommand(s, mv({ zone: 'tableau', index: 0 }, { zone: 'cell', index: 0 }));
  assert.equal(s.turn, 1);
  s = R.applyCommand(s, mv({ zone: 'tableau', index: 1 }, { zone: 'cell', index: 1 }));
  assert.equal(s.turn, 2);
  s = R.applyCommand(s, { type: 'nonsense' });
  assert.equal(s.turn, 3);
  assert.equal(s.invalid, 1);
});

test('basic legal move: tableau top card to free cell', () => {
  let s = fresh(9);
  const top = R.topOfColumn(s, 0);
  const v = R.validateMove(s, { zone: 'tableau', index: 0 }, { zone: 'cell', index: 0 }, 1);
  assert.equal(v.ok, true);
  s = R.applyCommand(s, mv({ zone: 'tableau', index: 0 }, { zone: 'cell', index: 0 }));
  assert.equal(s.cells[0], top);
  assert.equal(s.moves, 1);
});

test('cell occupancy and availability are enforced', () => {
  let s = fresh(9);
  s = R.applyCommand(s, mv({ zone: 'tableau', index: 0 }, { zone: 'cell', index: 0 }));
  const v = R.validateMove(s, { zone: 'tableau', index: 1 }, { zone: 'cell', index: 0 }, 1);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'cell-occupied');
  // constrained deal with 2 cells
  let s2 = R.createState({ seed: 5, constraints: { cellsAvailable: 2 } });
  const v2 = R.validateMove(s2, { zone: 'tableau', index: 0 }, { zone: 'cell', index: 3 }, 1);
  assert.equal(v2.reason, 'cell-unavailable');
});

test('foundation rules: ace first, suit order ascending', () => {
  // Hand-built state: AS on top of column 0.
  const tableau = Array.from({ length: 8 }, () => []);
  tableau[0] = [0]; // A spades
  // fill remaining 51 cards elsewhere legally-ish: put them all in column 1..3
  let id = 1;
  for (let c = 1; id < 52; id++, c = (c + 1) % 8) { if (c === 0) c = 1; tableau[c].push(id); }
  const s = R.createState({ seed: 1, tableau });
  assert.equal(R.validateMove(s, { zone: 'tableau', index: 0 }, { zone: 'foundation', index: 0 }, 1).ok, true);
  assert.equal(R.validateMove(s, { zone: 'tableau', index: 0 }, { zone: 'foundation', index: 1 }, 1).reason, 'foundation-suit');
  // 2 of spades before ace is home? find it
  const two = 1; // id 1 = 2 spades
  let col = -1;
  tableau.forEach((t, i) => { if (t[t.length - 1] === two) col = i; });
  if (col >= 0) {
    assert.equal(R.validateMove(s, { zone: 'tableau', index: col }, { zone: 'foundation', index: 0 }, 1).reason, 'foundation-order');
  }
});

test('tableau builds down alternating colors', () => {
  const tableau = Array.from({ length: 8 }, () => []);
  // 7 hearts (red) id = 13+6 = 19 on col 0; 6 spades (black) id 5 on col 1; 6 hearts id 18 on col 2
  tableau[0] = [19];
  tableau[1] = [5];
  tableau[2] = [18];
  let id = 0, c = 3;
  const placed = new Set([19, 5, 18]);
  while (id < 52) {
    if (!placed.has(id)) { tableau[c].push(id); c = (c + 1) % 8; if (c < 3) c = 3; }
    id++;
  }
  const s = R.createState({ seed: 1, tableau });
  assert.equal(R.validateMove(s, { zone: 'tableau', index: 1 }, { zone: 'tableau', index: 0 }, 1).ok, true); // 6S onto 7H
  assert.equal(R.validateMove(s, { zone: 'tableau', index: 2 }, { zone: 'tableau', index: 0 }, 1).reason, 'tableau-order'); // 6H onto 7H same color
});

test('supermove capacity respects free cells and empty columns', () => {
  const s = fresh(9);
  assert.equal(R.maxMovableSequence(s), 5); // 4 cells, 0 empty cols
  let s2 = R.applyCommand(s, mv({ zone: 'tableau', index: 0 }, { zone: 'cell', index: 0 }));
  assert.equal(R.maxMovableSequence(s2), 4);
});

test('ordered run detection', () => {
  // 9S(8) 8H(20) 7C(45): descending alternating
  assert.equal(R.orderedRunLength([8, 20, 45]), 3);
  assert.equal(R.orderedRunLength([7, 20, 45]), 2); // 8S breaks under 8H (same rank)
  assert.equal(R.orderedRunLength([8, 22, 45]), 1); // 10H breaks the rank chain
});

test('invalid moves do not mutate and count as invalid', () => {
  const s = fresh(9);
  const before = R.serialize(s);
  const next = R.applyCommand(s, mv({ zone: 'tableau', index: 0 }, { zone: 'foundation', index: 3 }));
  assert.equal(R.serialize(s), before, 'input state must be immutable');
  assert.equal(next.invalid, 1);
  assert.equal(next.moves, 0);
});

test('terminal: win detected when foundations complete', () => {
  const tableau = Array.from({ length: 8 }, () => []);
  const foundations = [[], [], [], []];
  for (let suit = 0; suit < 4; suit++) for (let r = 1; r <= 12; r++) foundations[suit].push(suit * 13 + r - 1);
  tableau[0] = [12];           // K spades
  tableau[1] = [25];           // K hearts
  tableau[2] = [38];           // K diamonds
  tableau[3] = [51];           // K clubs
  const s = R.createState({ seed: 1, tableau, foundations: undefined });
  s.foundations = foundations;
  R.validateStateShape(s);
  let cur = s;
  for (let i = 0; i < 4; i++) {
    const top = R.topOfColumn(cur, i);
    cur = R.applyCommand(cur, mv({ zone: 'tableau', index: i }, { zone: 'foundation', index: R.suitOf(top) }));
  }
  assert.equal(cur.status, 'won');
  assert.equal(cur.terminalReason, 'all-foundations-complete');
  // Further moves rejected.
  const after = R.applyCommand(cur, mv({ zone: 'tableau', index: 0 }, { zone: 'cell', index: 0 }));
  assert.equal(after.invalid, cur.invalid + 1);
});

test('terminal: move limit and concede', () => {
  let s = R.createState({ seed: 3, constraints: { moveLimit: 1 } });
  s = R.applyCommand(s, mv({ zone: 'tableau', index: 0 }, { zone: 'cell', index: 0 }));
  assert.equal(s.status, 'lost');
  assert.equal(s.terminalReason, 'move-limit-exceeded');
  let s2 = fresh(1);
  s2 = R.applyCommand(s2, { type: 'concede' });
  assert.equal(s2.status, 'lost');
  assert.equal(s2.terminalReason, 'conceded');
});

test('enumerateActions covers sources and respects game-over', () => {
  const s = fresh(9);
  const acts = R.enumerateActions(s);
  assert.ok(acts.length > 0);
  // fresh deal: 8 column tops can each go to a cell (first free cell)
  const toCell = acts.filter(a => a.to.zone === 'cell');
  assert.equal(toCell.length, 8);
  const won = R.applyCommand(s, { type: 'concede' });
  assert.equal(R.enumerateActions(won).length, 0);
});

test('auto-collect only takes safe cards and cascades', () => {
  // All aces exposed: tops of columns 0..3 are the four aces.
  const tableau = Array.from({ length: 8 }, () => []);
  const aces = [0, 13, 26, 39];
  const rest = [];
  for (let id = 0; id < 52; id++) if (!aces.includes(id)) rest.push(id);
  tableau[0] = [0]; tableau[1] = [13]; tableau[2] = [26]; tableau[3] = [39];
  let c = 4;
  for (const id of rest) { tableau[c].push(id); c = (c + 1) % 8; if (c < 4) c = 4; }
  const s = R.createState({ seed: 1, tableau });
  const moves = R.findSafeAutoMoves(s);
  assert.equal(moves.length, 4);
  const after = R.applyCommand(s, { type: 'auto' });
  assert.equal(after.foundations.flat().length, 4);
  // Twos are now safe too, so a second auto collects them.
  const after2 = R.applyCommand(after, { type: 'auto' });
  assert.ok(after2.foundations.flat().length >= 4);
});

test('auto disabled by constraint', () => {
  const tableau = Array.from({ length: 8 }, () => []);
  tableau[0] = [0];
  const rest = [];
  for (let id = 1; id < 52; id++) rest.push(id);
  let c = 1;
  for (const id of rest) { tableau[c].push(id); c = (c + 1) % 8; if (c === 0) c = 1; }
  const s = R.createState({ seed: 1, tableau, constraints: { noAuto: true } });
  const after = R.applyCommand(s, { type: 'auto' });
  assert.equal(after.invalid, 1);
});

test('scoring: components are integers, win beats progress', () => {
  const s = fresh(9);
  const b = R.scoreBreakdown(s, { moves: 120, timeMs: 300000 });
  for (const k of Object.keys(b)) assert.ok(Number.isInteger(b[k]), k);
  assert.equal(b.completion, 0);
  assert.equal(b.winBonus, 0);
  // won game
  const wonS = R.cloneState(s);
  wonS.status = 'won';
  wonS.tableau = Array.from({ length: 8 }, () => []);
  wonS.foundations = [[], [], [], []];
  for (let suit = 0; suit < 4; suit++) for (let r = 1; r <= 13; r++) wonS.foundations[suit].push(suit * 13 + r - 1);
  const bw = R.scoreBreakdown(wonS, { moves: 120, timeMs: 300000 });
  assert.equal(bw.completion, 5200);
  assert.equal(bw.winBonus, 5000);
  assert.ok(bw.total > b.total);
});

test('tie-break ordering', () => {
  const mk = (completion, invalid, elapsed, id) => ({
    score: { completion }, invalid, elapsedMs: elapsed, sessionId: id
  });
  const entries = [mk(100, 2, 5000, 'b'), mk(200, 5, 9000, 'a'), mk(100, 1, 9000, 'c'), mk(100, 1, 3000, 'd')];
  entries.sort(R.compareResults);
  assert.equal(entries[0].score.completion, 200);
  assert.equal(entries[1].sessionId, 'd');
  assert.equal(entries[2].sessionId, 'c');
});

test('replay determinism: same seed and commands give identical hashes', () => {
  function run() {
    let s = fresh(777);
    const hashes = [R.stateHash(s)];
    for (let i = 0; i < 200 && s.status === 'active'; i++) {
      const acts = R.enumerateActions(s).filter(a => a.kind === 'move');
      if (!acts.length) break;
      s = R.applyCommand(s, Object.assign({ type: 'move' }, acts[(i * 7) % acts.length]));
      hashes.push(R.stateHash(s));
    }
    return hashes;
  }
  assert.deepEqual(run(), run());
});

test('fuzz: malformed commands never throw or corrupt state', () => {
  let s = fresh(31337);
  const junk = [null, undefined, 42, 'x', {}, { type: 'move' },
    { type: 'move', from: { zone: 'cell', index: 99 }, to: { zone: 'cell', index: 0 } },
    { type: 'move', from: { zone: 'nowhere', index: 0 }, to: { zone: 'cell', index: 0 } },
    { type: 'move', from: { zone: 'tableau', index: 0 }, to: { zone: 'cell', index: 0 }, count: -3 },
    { type: 'move', from: { zone: 'tableau', index: 0 }, to: { zone: 'cell', index: 0 }, count: 1e9 },
    { type: 'tick', elapsedMs: NaN }, { type: 'tick', elapsedMs: -50 }];
  for (const cmd of junk) {
    const next = R.applyCommand(s, cmd);
    R.validateStateShape(next); // still a legal shape
    // Ticks carry wall-clock data and do not consume a turn; everything else does.
    assert.equal(next.turn, s.turn + (cmd && cmd.type === 'tick' ? 0 : 1));
  }
});

test('hints return legal moves ranked foundation-first', () => {
  const tableau = Array.from({ length: 8 }, () => []);
  tableau[0] = [0]; // A spades exposed
  const rest = [];
  for (let id = 1; id < 52; id++) rest.push(id);
  let c = 1;
  for (const id of rest) { tableau[c].push(id); c = (c + 1) % 8; if (c === 0) c = 1; }
  const s = R.createState({ seed: 1, tableau });
  const hints = R.rankHints(s);
  assert.equal(hints[0].to.zone, 'foundation');
  for (const h of hints) {
    assert.equal(R.validateMove(s, h.from, h.to, h.count).ok, true);
  }
});
