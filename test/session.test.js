'use strict';
/* Open Cells — session layer tests. Run: node --test test/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rules.js');
const S = require('../src/session.js');

function sess(seed = 42, extra = {}) {
  return S.createSession(Object.assign({ seed, dealId: 'test-' + seed }, extra));
}

test('legal move executes and is logged', () => {
  const s = sess();
  const acts = R.enumerateActions(s.state).filter(a => a.kind === 'move');
  const a = acts[0];
  const r = S.execute(s, { id: 'cmd-1', type: 'move', from: a.from, to: a.to, count: a.count });
  assert.equal(r.ok, true);
  assert.equal(s.state.moves, 1);
  assert.equal(s.log.length, 1);
});

test('duplicate command ids are rejected idempotently', () => {
  const s = sess();
  const acts = R.enumerateActions(s.state).filter(a => a.kind === 'move');
  const a = acts[0];
  S.execute(s, { id: 'dup', type: 'move', from: a.from, to: a.to, count: a.count });
  const r = S.execute(s, { id: 'dup', type: 'move', from: a.from, to: a.to, count: a.count });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'duplicate-command');
  assert.equal(s.state.moves, 1);
});

test('invalid action is explained and counted, not fatal', () => {
  const s = sess();
  const r = S.execute(s, { type: 'move', from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: 3 } });
  assert.equal(r.ok, false);
  assert.ok(r.reason);
  assert.equal(s.state.invalid, 1);
  assert.equal(s.lastInvalid.reason, r.reason);
});

test('undo restores the exact prior state and counts itself', () => {
  const s = sess();
  const before = R.serialize(s.state);
  const acts = R.enumerateActions(s.state).filter(a => a.kind === 'move');
  S.execute(s, { type: 'move', from: acts[0].from, to: acts[0].to, count: acts[0].count });
  assert.notEqual(R.serialize(s.state), before);
  const r = S.execute(s, { type: 'undo' });
  assert.equal(r.ok, true);
  const restored = R.cloneState(JSON.parse(before));
  restored.turn += 1; // the undo command itself
  restored.undos += 1;
  assert.equal(R.serialize(s.state), R.serialize(restored));
  // undo underflow
  const s2 = sess();
  assert.equal(S.execute(s2, { type: 'undo' }).reason, 'nothing-to-undo');
});

test('replay envelope validates to the same final hash', () => {
  const s = sess(777);
  for (let i = 0; i < 60 && s.state.status === 'active'; i++) {
    const acts = R.enumerateActions(s.state).filter(a => a.kind === 'move');
    if (!acts.length) break;
    const a = acts[(i * 5) % acts.length];
    S.execute(s, { type: 'move', from: a.from, to: a.to, count: a.count });
    if (i % 3 === 2) S.execute(s, { type: 'undo' });
    if (i % 7 === 3) S.execute(s, { type: 'move', from: { zone: 'tableau', index: 0 }, to: { zone: 'foundation', index: 3 } }); // likely invalid; logged either way
  }
  const env = S.exportReplay(s);
  const v = S.validateReplay(env);
  assert.equal(v.ok, true, JSON.stringify(v.mismatches));
  assert.equal(v.finalHash, env.finalHash);
});

test('replay validation catches tampering', () => {
  const s = sess(777);
  const acts = R.enumerateActions(s.state).filter(a => a.kind === 'move');
  S.execute(s, { type: 'move', from: acts[0].from, to: acts[0].to, count: acts[0].count });
  const env = S.exportReplay(s);
  env.finalHash = 'deadbeef';
  assert.equal(S.validateReplay(env).ok, false);
  const env2 = S.exportReplay(sess(777));
  env2.commands.push({ type: 'move', from: { zone: 'cell', index: 0 }, to: { zone: 'cell', index: 1 }, count: 1 });
  assert.equal(S.validateReplay(env2).ok, false);
});

test('lesson steps advance on the required action', () => {
  const lesson = {
    def: {
      steps: [
        { text: 'park it', require: 'move-to-cell' },
        { text: 'done', require: null }
      ]
    },
    stepIndex: 0
  };
  const s = sess(42, { lesson });
  const acts = R.enumerateActions(s.state).filter(a => a.to.zone === 'cell');
  const events = [];
  S.on(s, (e) => events.push(e.type));
  S.execute(s, { type: 'move', from: acts[0].from, to: acts[0].to, count: 1 });
  // Text-only trailing steps are skipped automatically: 2 = done.
  assert.equal(s.lesson.stepIndex, 2);
  assert.ok(events.includes('lesson-step'));
});

test('hints come from the same legal-action API', () => {
  const s = sess(42);
  const h = S.hint(s);
  assert.ok(h);
  assert.equal(R.validateMove(s.state, h.from, h.to, h.count).ok, true);
});

test('tick accumulates integer authoritative time and can end a timed deal', () => {
  const s = sess(42, { constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: 1000, noAuto: false } });
  S.execute(s, { type: 'tick', elapsedMs: 400.9 });
  assert.equal(s.state.elapsedMs, 400);
  S.execute(s, { type: 'tick', elapsedMs: 700 });
  assert.equal(s.state.status, 'lost');
  assert.equal(s.state.terminalReason, 'time-limit-exceeded');
});
