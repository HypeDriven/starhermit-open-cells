/*
 * Open Cells — session layer.
 * Owns the authoritative local session: validated commands, undo snapshots,
 * replay log, elapsed-time accounting, hints (same legal-action API as play),
 * and lesson step tracking. No rendering, no DOM.
 * Browser: window.OCSession. Node: module.exports.
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else global.OCSession = factory(global.OCRules);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  var REPLAY_SCHEMA = 1;
  var MAX_UNDO = 500;

  // options: { dealId, seed, constraints, par, mode, tableau, ranked, contentVersion }
  function createSession(options) {
    options = options || {};
    var state = R.createState({
      seed: options.seed,
      dealId: options.dealId,
      constraints: options.constraints,
      tableau: options.tableau,
      ruleset: options.ruleset
    });
    var session = {
      state: state,
      mode: options.mode || 'practice',
      ranked: !!options.ranked,
      par: options.par || null,
      contentVersion: options.contentVersion || 1,
      sessionId: options.sessionId || makeSessionId(state),
      undoStack: [],          // serialized prior states
      log: [],                // ordered applied commands (replay source)
      listeners: [],
      lesson: options.lesson || null,   // { def, stepIndex }
      tableau: options.tableau || null, // custom layouts (lessons) ride along for replay
      lastInvalid: null       // { reason, message } for UI explanation
    };
    normalizeLesson(session);
    return session;
  }

  // Text-only steps (no required action) are presentation; advance past them
  // so the tracker always rests on a step the player must perform.
  function normalizeLesson(session) {
    var l = session.lesson;
    if (!l) return;
    while (l.stepIndex < l.def.steps.length && !l.def.steps[l.stepIndex].require) l.stepIndex++;
    if (l.stepIndex >= l.def.steps.length) {
      emit(session, { type: 'lesson-step', index: l.stepIndex, done: true });
    }
  }

  function makeSessionId(state) {
    return 's-' + state.seed.toString(16) + '-' + (R.hashString(state.dealId) ^ state.seed).toString(16);
  }

  function on(session, fn) { session.listeners.push(fn); }
  function emit(session, event) {
    for (var i = 0; i < session.listeners.length; i++) session.listeners[i](event, session);
  }

  function snapshotOf(session) { return R.serialize(session.state); }

  // Execute a command through validation. Commands carry a client-generated id
  // so duplicate commits are rejected idempotently.
  function execute(session, cmd) {
    if (!cmd || typeof cmd !== 'object') return { ok: false, reason: 'bad-command' };
    if (cmd.id && session.log.some(function (c) { return c.id === cmd.id; })) {
      return { ok: false, reason: 'duplicate-command' };
    }
    var before = session.state;

    if (cmd.type === 'move' || cmd.type === 'auto') {
      var check = cmd.type === 'move'
        ? R.validateMove(before, cmd.from, cmd.to, cmd.count || 1)
        : (before.constraints.noAuto || R.findSafeAutoMoves(before).length === 0
          ? { ok: false, reason: 'nothing-to-collect', message: 'No card is safe to collect right now.' }
          : { ok: true });
      if (!check.ok) {
        session.state = R.applyCommand(before, cmd); // counts the invalid attempt, bumps turn
        // Invalid attempts stay in the log so replays reproduce them exactly.
        session.log.push({ id: cmd.id || null, type: 'invalid', reason: check.reason });
        session.lastInvalid = { reason: check.reason, message: check.message || check.reason };
        emit(session, { type: 'invalid', reason: check.reason, message: check.message });
        return { ok: false, reason: check.reason, message: check.message };
      }
      session.undoStack.push(snapshotOf(session));
      if (session.undoStack.length > MAX_UNDO) session.undoStack.shift();
      session.state = R.applyCommand(before, cmd);
      session.log.push({ id: cmd.id || null, type: cmd.type, from: cmd.from, to: cmd.to, count: cmd.count || 1 });
      session.lastInvalid = null;
      emit(session, { type: 'move', command: cmd });
      checkTerminal(session);
      checkLesson(session, cmd, before);
      return { ok: true };
    }

    if (cmd.type === 'undo') {
      if (session.undoStack.length === 0) {
        session.lastInvalid = { reason: 'nothing-to-undo', message: 'Nothing to undo.' };
        emit(session, { type: 'invalid', reason: 'nothing-to-undo', message: 'Nothing to undo.' });
        return { ok: false, reason: 'nothing-to-undo' };
      }
      var prev = session.undoStack.pop();
      session.state = R.deserialize(prev);
      session.state = R.applyCommand(session.state, { type: 'undo' }); // counts the undo
      session.log.push({ id: cmd.id || null, type: 'undo' });
      emit(session, { type: 'undo' });
      return { ok: true };
    }

    if (cmd.type === 'tick') {
      session.state = R.applyCommand(before, { type: 'tick', elapsedMs: cmd.elapsedMs });
      checkTerminal(session);
      return { ok: true };
    }

    if (cmd.type === 'concede') {
      session.state = R.applyCommand(before, { type: 'concede' });
      session.log.push({ id: cmd.id || null, type: 'concede' });
      emit(session, { type: 'concede' });
      checkTerminal(session);
      return { ok: true };
    }

    session.state = R.applyCommand(before, cmd); // invalid path: bumps turn/invalid
    emit(session, { type: 'invalid', reason: 'unknown-command', message: 'Unknown command.' });
    return { ok: false, reason: 'unknown-command' };
  }

  function checkTerminal(session) {
    if (session.state.status !== 'active') {
      emit(session, { type: 'terminal', status: session.state.status, reason: session.state.terminalReason });
    }
  }

  // Lesson step predicates share the same command stream as play.
  function checkLesson(session, cmd, before) {
    if (!session.lesson) return;
    var lesson = session.lesson;
    var step = lesson.def.steps[lesson.stepIndex];
    if (!step || !step.require) return;
    var ok = false;
    if (step.require === 'auto') ok = cmd.type === 'auto';
    else if (cmd.type === 'move') {
      if (step.require === 'move-to-cell') ok = cmd.to.zone === 'cell';
      else if (step.require === 'move-from-cell') ok = cmd.from.zone === 'cell';
      else if (step.require === 'move-to-tableau') ok = cmd.to.zone === 'tableau';
      else if (step.require === 'move-to-foundation') ok = cmd.to.zone === 'foundation';
      else if (step.require === 'move-sequence') ok = (cmd.count || 1) > 1;
    }
    if (ok) {
      lesson.stepIndex++;
      normalizeLesson(session);
      emit(session, { type: 'lesson-step', index: lesson.stepIndex, done: lesson.stepIndex >= lesson.def.steps.length });
    }
  }

  function lessonState(session) {
    if (!session.lesson) return null;
    return { def: session.lesson.def, stepIndex: session.lesson.stepIndex, total: session.lesson.def.steps.length };
  }

  function hint(session) {
    var ranked = R.rankHints(session.state);
    return ranked.length ? ranked[0] : null;
  }

  function score(session) { return R.scoreBreakdown(session.state, session.par); }

  // Replay envelope: schema, version, seed, initial hash, ordered commands,
  // periodic hashes, terminal result. Re-running must reproduce final hash.
  function exportReplay(session) {
    var initial = R.createState({
      seed: session.state.seed, dealId: session.state.dealId,
      constraints: session.state.constraints, tableau: session.tableau || undefined
    });
    return {
      schema: REPLAY_SCHEMA,
      contentVersion: session.contentVersion,
      dealId: session.state.dealId,
      seed: session.state.seed,
      ruleset: session.state.ruleset,
      constraints: session.state.constraints,
      tableau: session.tableau,
      initialHash: R.stateHash(initial),
      commands: session.log.slice(),
      finalHash: R.stateHash(session.state),
      result: {
        status: session.state.status,
        reason: session.state.terminalReason,
        moves: session.state.moves,
        invalid: session.state.invalid,
        undos: session.state.undos,
        elapsedMs: session.state.elapsedMs,
        score: score(session)
      }
    };
  }

  // Validate a replay envelope; returns { ok, finalHash, mismatches }.
  // Undo pops the same snapshot stack the session layer maintains.
  function validateReplay(envelope) {
    try {
      if (!envelope || envelope.schema !== REPLAY_SCHEMA) {
        return { ok: false, finalHash: null, mismatches: [{ index: -1, reason: 'bad-envelope' }] };
      }
      var s = R.createState({
        seed: envelope.seed, dealId: envelope.dealId,
        constraints: envelope.constraints, tableau: envelope.tableau || undefined
      });
      if (R.stateHash(s) !== envelope.initialHash) {
        return { ok: false, finalHash: null, mismatches: [{ index: -1, reason: 'initial-hash-mismatch' }] };
      }
      var stack = [];
      var mismatches = [];
      for (var i = 0; i < envelope.commands.length; i++) {
        var c = envelope.commands[i];
        if (c.type === 'undo') {
          if (stack.length === 0) { mismatches.push({ index: i, reason: 'undo-underflow' }); break; }
          s = stack.pop();
          s = R.applyCommand(s, { type: 'undo' });
          continue;
        }
        if (c.type === 'invalid') { s = R.applyCommand(s, { type: '__rejected' }); continue; }
        if (c.type === 'concede') { stack.push(s); s = R.applyCommand(s, { type: 'concede' }); continue; }
        var v = c.type === 'auto'
          ? (R.findSafeAutoMoves(s).length > 0 ? { ok: true } : { ok: false, reason: 'nothing-to-collect' })
          : R.validateMove(s, c.from, c.to, c.count || 1);
        if (!v.ok) { mismatches.push({ index: i, reason: v.reason }); break; }
        stack.push(s);
        s = R.applyCommand(s, c);
      }
      var finalHash = R.stateHash(s);
      if (finalHash !== envelope.finalHash) {
        mismatches.push({ index: -1, reason: 'final-hash-mismatch' });
      }
      return { ok: mismatches.length === 0, finalHash: finalHash, mismatches: mismatches };
    } catch (e) {
      return { ok: false, finalHash: null, mismatches: [{ index: -1, reason: String(e && e.message || e) }] };
    }
  }

  return {
    REPLAY_SCHEMA: REPLAY_SCHEMA,
    createSession: createSession,
    execute: execute,
    on: on,
    snapshotOf: snapshotOf,
    hint: hint,
    score: score,
    lessonState: lessonState,
    exportReplay: exportReplay,
    validateReplay: validateReplay
  };
});
