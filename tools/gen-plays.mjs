// Writes the generated play scripts in tests/native/ from the rules: the
// moves come from a depth-first solver (tools/validate.js's, recording its
// path) or from the lessons' required actions, and each move becomes a click
// (or a finger's touch on phones) on the source card's named target and then
// on the destination's — the names native/screens.ts gives the board's cards
// and slots (board-dom.js's aria labels), in en-US.
//   node tools/gen-plays.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const R = require('../src/rules.js');
const C = require('../src/content.js');

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['ace', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king'];
const words = (id) => `${RANKS[R.rankOf(id) - 1]} of ${SUITS[R.suitOf(id)]}`;

/** The named target of a location's card at depth d (or the slot), as screens.ts names it. */
function name(s, loc, d) {
  if (loc.zone === 'cell') {
    const id = s.cells[loc.index];
    return id == null ? `Empty cell ${loc.index + 1}` : `${words(id)}, cell ${loc.index + 1}`;
  }
  if (loc.zone === 'foundation') {
    const f = s.foundations[loc.index];
    return f.length ? `${words(f[f.length - 1])}, ${SUITS[loc.index]} foundation` : `${SUITS[loc.index]} foundation, empty`;
  }
  const col = s.tableau[loc.index];
  if (!col.length) return `Empty column ${loc.index + 1}`;
  const depth = d == null ? col.length - 1 : d;
  return `${words(col[depth])}, column ${loc.index + 1}, card ${depth + 1} of ${col.length}`;
}

// ---------------------------------------------------------------- solver (tools/validate.js, with the path kept)
function canonKey(s) {
  const cells = s.cells.filter((x) => x !== null).sort((a, b) => a - b);
  const cols = s.tableau.map((c) => c.join(',')).sort();
  return JSON.stringify([cells, s.foundations.map((f) => f.length), cols]);
}
function orderedMoves(s) {
  const acts = R.enumerateActions(s).filter((a) => a.kind === 'move');
  let emptyUsed = false;
  const out = [];
  for (const a of acts) {
    if (a.to.zone === 'tableau' && s.tableau[a.to.index].length === 0) {
      if (emptyUsed) continue;
      emptyUsed = true;
    }
    let score = 0;
    if (a.to.zone === 'foundation') score = 100;
    else if (a.to.zone === 'tableau' && s.tableau[a.to.index].length > 0) score = 60 + a.count * 2;
    else if (a.to.zone === 'tableau') score = a.count > 1 ? 40 + a.count : 25;
    else score = 5;
    if (a.from.zone === 'cell') score += 15;
    if (a.to.zone === 'tableau' && s.tableau[a.to.index].length === 0 && a.from.zone === 'tableau' && a.count < s.tableau[a.from.index].length) score += 10;
    out.push({ a, score });
  }
  out.sort((x, y) => y.score - x.score);
  return out.map((x) => x.a);
}
/** Safe foundation moves applied one by one (the solver's forced auto-collect), as explicit moves. */
function autoMoves(s) {
  const path = [];
  let cur = s;
  for (;;) {
    if (cur.status !== 'active') return { s: cur, path };
    const m = R.findSafeAutoMoves(cur).find((x) => R.validateMove(cur, x.from, x.to, 1).ok);
    if (!m) return { s: cur, path };
    const a = { from: m.from, to: m.to, count: 1 };
    path.push(a);
    cur = R.applyCommand(cur, { type: 'move', ...a });
  }
}
/** Best-first search on cards home, cards buried over the next foundation cards and parked cards: short solutions. */
function solve(seed, constraints) {
  const h = (s) => {
    let home = 0, buried = 0;
    s.foundations.forEach((f) => { home += f.length; });
    for (let suit = 0; suit < 4; suit++) {
      const need = suit * 13 + s.foundations[suit].length;
      s.tableau.forEach((col) => { const i = col.indexOf(need); if (i >= 0) buried += col.length - 1 - i; });
    }
    const parked = s.cells.filter((c) => c !== null).length;
    const empty = s.tableau.filter((c) => !c.length).length;
    return (52 - home) * 3 + buried * 2 + parked - empty;
  };
  const heap = [];
  const push = (n) => { heap.push(n); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const t = heap[0], l = heap.pop(); if (heap.length) { heap[0] = l; let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < heap.length && heap[a].f < heap[m].f) m = a; if (b < heap.length && heap[b].f < heap[m].f) m = b; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return t; };
  const first = autoMoves(R.createState({ seed, constraints }));
  const seen = new Set([canonKey(first.s)]);
  push({ s: first.s, path: first.path, f: h(first.s) });
  let nodes = 0;
  while (heap.length) {
    if (nodes++ > 300000) throw new Error('solver cap');
    const fr = pop();
    for (const a of orderedMoves(fr.s)) {
      const step = { from: a.from, to: a.to, count: a.count };
      const next = R.applyCommand(fr.s, { type: 'move', ...step });
      if (next.status !== 'active' && next.status !== 'won') continue;
      const auto = autoMoves(next);
      const path = [...fr.path, step, ...auto.path];
      if (auto.s.status === 'won') return path;
      const key = canonKey(auto.s);
      if (seen.has(key)) continue;
      seen.add(key);
      push({ s: auto.s, path, f: h(auto.s) + path.length * 0.5 });
    }
  }
  throw new Error('no solution');
}

/** Click lines for a move list from a state (source card, then destination). */
function moveLines(state, moves, verb) {
  const out = [];
  let s = state;
  for (const m of moves) {
    const src = m.from.zone === 'tableau' ? s.tableau[m.from.index].length - m.count : null;
    out.push('frames 6', `${verb} =${name(s, m.from, src)}`, 'frames 6', `${verb} =${name(s, m.to)}`);
    s = R.applyCommand(s, { type: 'move', ...m });
    if (s.status === 'lost') throw new Error('lost');
  }
  return out;
}
const write = (file, lines) => { writeFileSync(join(root, 'tests', 'native', file), lines.join('\n') + '\n'); console.log(file, lines.length, 'lines'); };

// ---- Journey stage 1, solved to its results on a desktop
{
  const st = C.JOURNEY[0];
  const moves = solve(st.seed, st.constraints);
  const state = R.createState({ seed: st.seed, constraints: st.constraints });
  write('journey-1.play', [
    `# Generated by tools/gen-plays.mjs: Journey stage 1 (seed ${st.seed}) on a desktop, ${moves.length} moves by clicks`,
    '# on the cards\' and slots\' named targets, to the results.',
    '# viewport 1280x800@1',
    'until 600 Daily Deal',
    'frames 10',
    'click =Journey',
    'until 120 Complete a stage',
    'frames 10',
    'click Stage 1: First Light',
    'until 120 Begin stage',
    'frames 10',
    'save journey-stage',
    'click =Begin stage',
    'until 300 =Undo',
    'frames 60',
    'save desk-desktop',
    ...moveLines(state, moves, 'click'),
    'until 600 Deal cleared.',
    'frames 30',
    'expect Total',
    'save results-desktop',
    'click =Next stage',
    'until 300 journey-02',
  ]);
}

// ---- The six lessons on a phone, by a finger, through the tray's Collect, to the last lesson's results
{
  const lines = [
    '# Generated by tools/gen-plays.mjs: the six Learn lessons on a phone (390 x 844, DPR 3) by touch,',
    '# each lesson\'s required move on the named targets (Collect from the tray), through the results.',
    '# viewport 390x844@3',
    'until 600 Daily Deal',
    'frames 10',
    'touch =Learn',
    'until 120 Lessons ask you',
    'frames 10',
    'save learn-phone',
    'touch =Start: Build Down the Tableau',
    'until 300 =Collect',
    'frames 60',
    'save desk-phone',
  ];
  // The first move each lesson asks for, by its predicate.
  const want = {
    'move-to-tableau': (a) => a.to.zone === 'tableau',
    'move-to-cell': (a) => a.to.zone === 'cell',
    'move-from-cell': (a) => a.from.zone === 'cell',
    'move-to-foundation': (a) => a.to.zone === 'foundation',
    'move-sequence': (a) => a.count > 1,
  };
  C.LESSONS.forEach((ls, i) => {
    let s = R.createState({ seed: 1, tableau: ls.setup() });
    for (const step of ls.steps.filter((x) => x.require)) {
      if (step.require === 'auto') { lines.push('frames 6', 'touch =Collect'); continue; }
      const acts = R.enumerateActions(s).filter((a) => a.kind === 'move' && want[step.require](a));
      // Prefer moves onto the lesson's focus columns (the deliberate one), then any.
      // The lesson's focus cards sit in its short columns (the rest of the deck is piled elsewhere).
      const srcLen = (x) => (x.from.zone === 'tableau' ? s.tableau[x.from.index].length : 0);
      acts.sort((x, y) => srcLen(x) - srcLen(y) || (y.to.zone === 'tableau' && s.tableau[y.to.index].length > 0 ? 1 : 0) - (x.to.zone === 'tableau' && s.tableau[x.to.index].length > 0 ? 1 : 0));
      const a = acts[0];
      lines.push(...moveLines(s, [a], 'touch'));
      s = R.applyCommand(s, { type: 'move', from: a.from, to: a.to, count: a.count });
    }
    lines.push('until 300 Deal cleared.', 'frames 20');
    if (i === 0) lines.push('save results-phone');
    if (i < C.LESSONS.length - 1) lines.push('touch =Next lesson', 'until 300 =Collect', 'frames 30');
  });
  lines.push('expect Achievements unlocked', 'save lessons-done-phone', 'touch =Leave', 'until 300 Daily Deal');
  write('lessons-phone.play', lines);
}
