'use strict';
/*
 * Open Cells — offline content validator (spec §2: prove basic legality,
 * reachable goals, absence of soft locks).
 *
 *   node tools/validate.js            validate all content (parallel, streaming)
 *   node tools/validate.js --rescue   also find replacement seeds for any
 *                                     unproven deal (parallel candidate scan)
 *
 * Solver: iterative DFS with a transposition table. Safe auto-collects are
 * forced (no branching). Empty columns are interchangeable — only one empty
 * target is ever branched on.
 */
const R = require('../src/rules.js');
const C = require('../src/content.js');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const os = require('os');

const NODE_CAP = 200000;

// ---------------------------------------------------------------- solver core

function canonKey(s) {
  const cells = s.cells.filter(x => x !== null).sort((a, b) => a - b);
  const cols = s.tableau.map(c => c.join(',')).sort();
  return JSON.stringify([cells, s.foundations.map(f => f.length), cols]);
}

function forcedAuto(s) {
  if (s.constraints && s.constraints.noAuto) return s; // noAuto deals: nothing is forced
  let cur = s;
  for (;;) {
    if (cur.status !== 'active') return cur; // terminal states reject moves
    const moves = R.findSafeAutoMoves(cur);
    if (!moves.length) return cur;
    let applied = false;
    for (const m of moves) {
      const v = R.validateMove(cur, m.from, m.to, 1);
      if (v.ok) {
        cur = R.applyCommand(cur, { type: 'move', from: m.from, to: m.to, count: 1 });
        applied = true;
      }
    }
    if (!applied) return cur; // no progress possible (e.g. limit reached) — stop
  }
}

function orderedMoves(s) {
  const acts = R.enumerateActions(s).filter(a => a.kind === 'move');
  let emptyUsed = false;
  const out = [];
  for (const a of acts) {
    if (a.to.zone === 'tableau' && s.tableau[a.to.index].length === 0) {
      if (emptyUsed) continue; // empty columns are interchangeable
      emptyUsed = true;
    }
    let score = 0;
    if (a.to.zone === 'foundation') score = 100;
    else if (a.to.zone === 'tableau' && s.tableau[a.to.index].length > 0) score = 60 + a.count * 2;
    else if (a.to.zone === 'tableau') score = a.count > 1 ? 40 + a.count : 25;
    else score = 5;
    if (a.from.zone === 'cell') score += 15;
    if (a.to.zone === 'tableau' && s.tableau[a.to.index].length === 0 &&
        a.from.zone === 'tableau' && a.count < s.tableau[a.from.index].length) score += 10;
    out.push({ a, score });
  }
  out.sort((x, y) => y.score - x.score);
  return out.map(x => x.a);
}

function solvable(seed, constraints, cap) {
  const NODE_LIMIT = cap || NODE_CAP;
  const start = forcedAuto(R.createState({ seed, constraints }));
  if (start.status === 'won') return { ok: true, nodes: 0, movesUsed: start.moves };
  const seen = new Set();
  let nodes = 0;
  const stack = [{ s: start, moves: orderedMoves(start), next: 0 }];
  seen.add(canonKey(start));
  while (stack.length) {
    if (nodes++ > NODE_LIMIT) return { ok: false, nodes, capped: true };
    const frame = stack[stack.length - 1];
    if (frame.next >= frame.moves.length) { stack.pop(); continue; }
    const a = frame.moves[frame.next++];
    let next = R.applyCommand(frame.s, { type: 'move', from: a.from, to: a.to, count: a.count });
    if (next.status === 'won') return { ok: true, nodes, movesUsed: next.moves };
    if (next.status !== 'active') continue;
    next = forcedAuto(next);
    if (next.status === 'won') return { ok: true, nodes, movesUsed: next.moves };
    const key = canonKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    stack.push({ s: next, moves: orderedMoves(next), next: 0 });
  }
  return { ok: false, nodes };
}

// A move-limited deal is proven by exhibiting a solution within the limit.
// DFS solutions are long, so first try with the limit binding; if that fails,
// relax the limit and check the witness solution's length.
function proveDeal(seed, constraints, cap) {
  const direct = solvable(seed, constraints, cap);
  if (direct.ok) return direct;
  if (Number.isInteger(constraints.moveLimit)) {
    const relaxed = Object.assign({}, constraints, { moveLimit: null });
    const r = solvable(seed, relaxed, cap);
    if (r.ok && r.movesUsed <= constraints.moveLimit) {
      return { ok: true, nodes: r.nodes, movesUsed: r.movesUsed, viaWitness: true };
    }
  }
  return direct;
}

// ---------------------------------------------------------------- worker side

if (!isMainThread) {
  const t = workerData;
  const r = proveDeal(t.seed, t.constraints, t.cap);
  parentPort.postMessage({ jobId: t.jobId, result: r });
  return;
}

// ---------------------------------------------------------------- main side

function validateLesson(ls) {
  const S = require('../src/session.js');
  function fresh() {
    return S.createSession({
      seed: 1, dealId: ls.id, tableau: ls.setup(),
      constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: false },
      lesson: { def: ls, stepIndex: 0 }
    });
  }
  function matches(step, a) {
    if (step.require === 'auto') return a.kind === 'auto';
    if (a.kind !== 'move') return false;
    if (step.require === 'move-to-cell') return a.to.zone === 'cell';
    if (step.require === 'move-from-cell') return a.from.zone === 'cell';
    if (step.require === 'move-to-tableau') return a.to.zone === 'tableau' && a.from.zone !== 'cell';
    if (step.require === 'move-to-foundation') return a.to.zone === 'foundation';
    if (step.require === 'move-sequence') return a.count > 1;
    return false;
  }
  // DFS over the lesson's required steps: the first matching action is not
  // always the intended one, so backtrack over alternatives.
  function dfs(session, depth) {
    if (depth > 12) return false;
    const idx = session.lesson.stepIndex;
    if (idx >= ls.steps.length) return true;
    const step = ls.steps[idx];
    if (!step.require) { session.lesson.stepIndex++; return dfs(session, depth); }
    const options = R.enumerateActions(session.state).filter(a => matches(step, a));
    for (const a of options) {
      const clone = S.createSession({
        seed: 1, dealId: ls.id, tableau: ls.setup(),
        constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: false },
        lesson: { def: ls, stepIndex: idx }
      });
      clone.state = R.cloneState(session.state);
      clone.lesson.stepIndex = idx;
      S.execute(clone, a.kind === 'auto' ? { type: 'auto' } : { type: 'move', from: a.from, to: a.to, count: a.count });
      if (clone.lesson.stepIndex > idx && dfs(clone, depth + 1)) return true;
    }
    return false;
  }
  const okLesson = dfs(fresh(), 0);
  return { ok: okLesson, step: -1, require: okLesson ? null : 'path' };
}

// Generic worker pool: jobs { jobId, seed, constraints } -> results.
function makePool(size) {
  const queue = [];
  const callbacks = new Map();
  let active = 0;
  function pump() {
    while (active < size && queue.length) {
      const job = queue.shift();
      active++;
      const w = new Worker(__filename, { workerData: job });
      w.once('message', (m) => {
        active--;
        w.terminate();
        const cb = callbacks.get(m.jobId);
        callbacks.delete(m.jobId);
        if (cb) cb(m.result);
        pump();
      });
      w.once('error', (e) => {
        active--;
        const cb = callbacks.get(job.jobId);
        callbacks.delete(job.jobId);
        if (cb) cb({ ok: false, nodes: -1, error: String(e) });
        pump();
      });
    }
  }
  return {
    run(job) {
      return new Promise((resolve) => {
        callbacks.set(job.jobId, resolve);
        queue.push(job);
        pump();
      });
    }
  };
}

async function main() {
  const doRescue = process.argv.includes('--rescue');
  const pool = makePool(Math.min(os.cpus().length, 16));

  // Lessons: in-process (setup closures can't cross worker boundaries).
  let failures = 0;
  for (const ls of C.LESSONS) {
    const r = validateLesson(ls);
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${ls.id} (lesson${r.ok ? '' : ', step ' + r.step + ' "' + r.require + '" not performable'})`);
    if (!r.ok) failures++;
  }

  const deals = [];
  for (const st of C.JOURNEY) deals.push({ id: st.id, seed: st.seed, constraints: st.constraints, prefix: 'open-cells/journey/' + st.n });
  for (const ch of C.CHALLENGES) deals.push({ id: ch.id, seed: C.challengeSeed(ch), constraints: ch.constraints, prefix: 'open-cells/challenge/' + ch.id });
  for (let d = -1; d <= 1; d++) {
    const info = C.dailyInfo(new Date(Date.now() + d * 86400000));
    deals.push({ id: info.id, seed: info.seed, constraints: info.constraints, prefix: null }); // daily seeds immutable
  }

  console.log(`validating ${deals.length} deals (node cap ${NODE_CAP})…`);
  const pending = deals.map((t, i) =>
    pool.run({ jobId: 'd' + i, seed: t.seed, constraints: t.constraints }).then(r => {
      t.result = r;
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${t.id} seed=${t.seed} nodes=${r.nodes}`);
    })
  );
  await Promise.all(pending);

  const failed = deals.filter(t => !t.result.ok);
  const patch = {};
  if (failed.length && doRescue) {
    // Rescue candidates get a small node cap: a deal this solver can prove
    // quickly is a good authored seed. More salts compensate for the cap.
    const RESCUE_CAP = 40000;
    const SALTS = 160;
    console.log(`\nrescuing ${failed.length} deals (cap ${RESCUE_CAP}, ${SALTS} salts each, parallel)…`);
    await Promise.all(failed.filter(t => t.prefix).map(async (t) => {
      // First salt that proves solvable wins.
      const results = await Promise.all(
        Array.from({ length: SALTS }, (_, s) => {
          const seed = R.hashString(t.prefix + '/alt-' + s);
          return pool.run({ jobId: t.id + '/r' + s, seed, constraints: t.constraints, cap: RESCUE_CAP })
            .then(r => ({ seed, r }));
        })
      );
      const best = results.find(x => x.r.ok);
      if (best) { patch[t.id] = best.seed; console.log(`  rescued ${t.id} -> ${best.seed} (nodes=${best.r.nodes})`); }
      else console.log(`  NO RESCUE for ${t.id} in ${SALTS} candidates`);
    }));
  }

  for (const t of failed) if (!patch[t.id]) failures++;
  const total = deals.length + C.LESSONS.length;
  console.log(`\n${total - failures}/${total} content items proven.`);
  if (Object.keys(patch).length) {
    console.log('\nSeed patch (bake into src/content.js):');
    console.log(JSON.stringify(patch, null, 2));
  }
  process.exit(failures ? (Object.keys(patch).length === failed.filter(t => t.prefix).length ? 2 : 1) : 0);
}

main();
