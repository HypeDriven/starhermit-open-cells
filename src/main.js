/*
 * Open Cells — bootstrap & orchestration.
 * Owns the app state machine (boot → title → mode-select → preparing →
 * active ↔ paused → resolving → results → progression), wires the rules
 * session to the renderer, the semantic DOM board, audio, persistence,
 * keyboard and gamepad input, and the host platform adapter.
 * Browser only.
 */
(function (global) {
  'use strict';

  var R = global.OCRules;
  var C = global.OCContent;
  var S = global.OCSession;
  var P = global.OCPlatform;
  var A = global.OCAudio;

  var app = {
    phase: 'boot',           // boot|title|setup|active|paused|results
    session: null,
    config: null,            // { mode, dealId, seed, constraints, par, ranked, board, journeyStage?, lesson?, challenge? }
    renderer: null,
    use3d: false,
    board: null,
    ui: null,
    selection: null,         // { loc, count, cardIds }
    hintAction: null,
    paused: false,
    lastTickAt: 0,
    tickTimer: 0,
    presenceTimer: 0,
    save: null,
    settings: null,
    cmdSeq: 0,
    lastTap: { cardId: null, at: 0 }
  };

  function $(sel) { return document.querySelector(sel); }

  function cmdId() { return 'c' + (++app.cmdSeq) + '-' + Date.now().toString(36); }

  // ---------------------------------------------------------------- boot

  function boot() {
    app.settings = P.getSettings();
    var loaded = P.loadSave();
    app.save = loaded.doc;
    if (loaded.conflict) {
      // Corrupt save preserved under a side key; start clean, tell the player.
      setTimeout(function () {
        app.ui.announce('A saved progress file was damaged and has been preserved separately. Starting fresh.', true);
      }, 500);
    }

    app.ui = global.OCUi.createUi(document, actions);
    app.ui.bindHud(document);
    P.onStatus(function (st) { app.ui.updatePlayer(st); });
    app.ui.applySettings(app.settings);

    var canvas = $('#scene');
    app.use3d = global.OCRender.isSupported() && !app.settings.htmlMode;
    if (app.use3d) {
      try {
        app.renderer = global.OCRender.createRenderer(canvas, {
          theme: currentTheme(),
          graphics: graphicsSettings(),
          reducedMotion: app.settings.reducedMotion
        });
        app.renderer.onPointerAction(onPointerAction);
        app.renderer.start();
        canvas.addEventListener('pointerdown', function () {
          // Fast-forward: any press settles cosmetic animation into the exact
          // deterministic end state.
          if (app.renderer.isAnimating()) app.renderer.settle();
          A.unlock();
        }, true);
      } catch (e) {
        app.use3d = false;
        app.renderer = null;
      }
    }
    if (!app.use3d) {
      canvas.classList.add('hidden');
      var note = $('#webgl-note');
      if (note) note.classList.remove('hidden');
    }
    document.body.classList.toggle('html-mode', !app.use3d);

    app.board = global.OCBoardDom.createBoard($('#dom-board'), {
      onCard: onDomCard,
      onSlot: onDomSlot
    });

    wireHudButtons();
    wireGlobalInput();
    wireLifecycle();
    P.syncTime();
    // Hosted: adopt the cloud mirror when it is newer than the local cache
    // (remote-preferred on conflict). localStorage stays the offline cache.
    P.loadCloudSave().then(function (remote) {
      if (!remote) return;
      var changed = false;
      var remoteTime = Date.parse((remote.save && remote.save.updatedAt) || '') || 0;
      var localTime = Date.parse(app.save.updatedAt || '') || 0;
      if (remote.save && (!app.save.updatedAt || remoteTime > localTime)) {
        app.save = P.adoptSave(remote.save);
        changed = true;
        app.ui.announce('Progress restored from your StarHermit cloud save.', false);
      }
      if (remote.boards && remote.boards.boards) changed = P.mergeBoards(remote.boards) || changed;
      if (!changed) return;
      P.persistSave(app.save);
      if (app.phase === 'title' && app.ui.topScreenName() === 'title') {
        app.ui.closeAll();
        showTitle();
      }
    });

    app.phase = 'title';
    showTitle();
    P.telemetry('start', {});
    global.__ocApp = app; // debug/self-test handle; not used by gameplay
  }

  function currentTheme() {
    var t = C.THEMES.find(function (t) { return t.id === app.settings.theme; });
    return t || C.THEMES[0];
  }

  // Saved Graphics settings; players who only ever chose the legacy
  // "Quality tier" keep that choice as their preset.
  function graphicsSettings() {
    return app.settings.graphics || global.OCGfx.fromLegacy(app.settings.quality);
  }

  // What the Graphics panel shows (GPU, Auto's choice, resolved tiers, cost).
  function graphicsInfo() {
    if (app.renderer) return app.renderer.graphicsInfo();
    return null;
  }

  // ---------------------------------------------------------------- title & modes

  function titleData() {
    var daily = C.dailyInfo(P.now());
    return {
      hasSnapshot: !!app.save.lastSnapshot,
      journey: app.save.journey,
      lessons: app.save.lessons,
      journeyDone: Object.keys(app.save.journey).length,
      dailyStreak: app.save.dailyStreak.count,
      dailyId: daily.date,
      msToNextDaily: C.msUntilNextUtcDay(P.now())
    };
  }

  function showTitle() {
    app.phase = 'title';
    app.ui.showTitle(titleData());
  }

  function dailyClockMode() {
    if (P.apiAvailable()) return 'hosted';
    return P.clockSynced() ? 'synced' : 'local';
  }

  var actions = {
    onPlay: function () {
      if (app.save.lastSnapshot) { resumeSnapshot(); return; }
      startPractice(C.PRACTICE_DIFFICULTIES[1]);
    },
    onMode: function (id) {
      if (id === 'learn') app.ui.showLearn(titleData());
      else if (id === 'journey') app.ui.showJourney(titleData());
      else if (id === 'daily') app.ui.showDailySetup(C.dailyInfo(P.now()), dailyClockMode());
      else if (id === 'practice') app.ui.showPracticeSetup();
      else if (id === 'challenge') app.ui.showChallengeSetup();
      else if (id === 'chase') app.ui.showChaseSetup();
    },
    onDaily: function () { app.ui.showDailySetup(C.dailyInfo(P.now()), dailyClockMode()); },
    onStartJourney: startJourney,
    onStartLesson: startLesson,
    onStartPractice: startPractice,
    onStartChallenge: startChallenge,
    onStartDaily: startDaily,
    onStartChase: startChase,
    onResume: resumeGame,
    onRetry: retryDeal,
    onLeave: leaveToTitle,
    onNext: nextAfterResults,
    onSettingsChanged: applySettings,
    graphicsInfo: graphicsInfo,
    onWipe: wipeAll,
    onOverlayClosed: function (name) {
      if (name === 'pause' && app.phase === 'paused') resumeGame();
    }
  };

  // ---------------------------------------------------------------- starting modes

  function startJourney(st) {
    startSession({
      mode: 'journey', dealId: st.id, seed: st.seed,
      constraints: st.constraints, par: st.par, ranked: true, board: 'journey',
      journeyStage: st, theme: st.theme
    });
  }

  function startLesson(ls) {
    var tableau = ls.setup();
    startSession({
      mode: 'learn', dealId: ls.id, seed: 1, tableau: tableau,
      constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: false },
      par: null, ranked: false, lesson: ls
    });
  }

  function startPractice(diff) {
    var seed = Math.floor(Math.random() * 0x7fffffff);
    startSession({
      mode: 'practice', dealId: 'practice-' + seed, seed: seed,
      constraints: diff.constraints, par: { moves: 130, timeMs: 420000 },
      ranked: false, board: 'practice-local'
    });
  }

  function startChallenge(ch) {
    var seed = C.challengeSeed(ch);
    startSession({
      mode: 'challenge', dealId: ch.id, seed: seed,
      constraints: ch.constraints, par: ch.par, ranked: true, board: 'challenge', challenge: ch
    });
  }

  function startDaily(daily) {
    startSession({
      mode: 'daily', dealId: daily.id, seed: daily.seed,
      constraints: daily.constraints, par: daily.par, ranked: true, board: 'daily'
    });
  }

  function startChase(seedStr) {
    var seed = R.hashString('open-cells/chase/' + seedStr);
    startSession({
      mode: 'chase', dealId: 'chase-' + seedStr, seed: seed,
      constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: false },
      par: { moves: 120, timeMs: 360000 }, ranked: true, board: 'chase'
    });
  }

  // ---------------------------------------------------------------- session lifecycle

  function startSession(config) {
    app.config = config;
    app.cmdSeq = 0;
    app.selection = null;
    app.hintAction = null;
    app.paused = false;
    app.phase = 'active';

    app.session = S.createSession({
      seed: config.seed,
      dealId: config.dealId,
      constraints: config.constraints,
      par: config.par,
      tableau: config.tableau,
      mode: config.mode,
      ranked: config.ranked,
      lesson: config.lesson ? { def: config.lesson, stepIndex: 0 } : null
    });

    S.on(app.session, onSessionEvent);

    if (app.renderer && config.theme && config.theme !== app.settings.theme) {
      // Stage themes are presentation-only data; honor them per deal.
      var t = C.THEMES.find(function (x) { return x.id === config.theme; });
      if (t) app.renderer.setTheme(t);
    } else if (app.renderer) {
      app.renderer.setTheme(currentTheme());
    }

    syncViews(true);
    A.play('deal', config.seed);
    startTicking();
    activity('start');
    P.telemetry('start', { mode: config.mode });

    var objective = objectiveText();
    app.ui.announce(objective + ' Deal ' + config.dealId + '.', false);
    updateHud();

    // Learn mode: surface the current lesson step.
    if (config.lesson) showLessonStep();
  }

  function objectiveText() {
    var c = app.config;
    var base = 'Build all four foundations, ace to king.';
    if (!c) return base;
    var cons = c.constraints || {};
    var extras = [];
    if (cons.moveLimit) extras.push('within ' + cons.moveLimit + ' moves');
    if (cons.timeLimitMs) extras.push('within ' + global.OCUi.fmtTime(cons.timeLimitMs));
    if (c.mode === 'learn' && c.lesson) return c.lesson.title + ': ' + (c.lesson.steps[0] ? c.lesson.steps[0].text : base);
    return extras.length ? base + ' Win ' + extras.join(' and ') + '.' : base;
  }

  function resumeSnapshot() {
    var snap = app.save.lastSnapshot;
    if (!snap) return;
    try {
      app.config = snap.config;
      app.cmdSeq = snap.cmdSeq || 0;
      app.selection = null;
      app.hintAction = null;
      app.paused = false;
      app.phase = 'active';
      app.session = S.createSession({
        seed: snap.config.seed, dealId: snap.config.dealId,
        constraints: snap.config.constraints, par: snap.config.par,
        tableau: snap.config.tableau, mode: snap.config.mode, ranked: snap.config.ranked,
        lesson: snap.config.lesson ? { def: snap.config.lesson, stepIndex: snap.lessonStep || 0 } : null
      });
      app.session.state = R.deserialize(snap.state);
      app.session.log = snap.log || [];
      S.on(app.session, onSessionEvent);
      syncViews(true);
      startTicking();
      updateHud();
      app.ui.announce('Resumed deal ' + snap.config.dealId + '. While you were away the clock was paused.', false);
    } catch (e) {
      app.save.lastSnapshot = null;
      P.persistSave(app.save);
      startPractice(C.PRACTICE_DIFFICULTIES[1]);
    }
  }

  function saveSnapshot() {
    if (!app.session || app.phase === 'results') return;
    app.save.lastSnapshot = {
      config: app.config,
      state: R.serialize(app.session.state),
      log: app.session.log,
      cmdSeq: app.cmdSeq,
      lessonStep: app.session.lesson ? app.session.lesson.stepIndex : 0
    };
    P.persistSave(app.save);
  }

  function clearSnapshot() {
    app.save.lastSnapshot = null;
    P.persistSave(app.save);
  }

  function retryDeal() {
    if (!app.config) return showTitle();
    var cfg = app.config;
    if (cfg.mode === 'practice') startPractice(C.PRACTICE_DIFFICULTIES[1]);
    else startSession(cfg); // same deal, fresh attempt
    P.telemetry('retry', { mode: cfg.mode });
  }

  function leaveToTitle() {
    stopTicking();
    activity('end');
    app.session = null;
    app.phase = 'title';
    showTitle();
  }

  function nextAfterResults() {
    var cfg = app.config;
    if (cfg && cfg.mode === 'journey' && cfg.journeyStage) {
      var next = C.JOURNEY[cfg.journeyStage.n]; // n is 1-based; next index = n
      if (next) { startJourney(next); return; }
    }
    if (cfg && cfg.mode === 'learn') {
      var idx = C.LESSONS.indexOf(cfg.lesson);
      if (idx >= 0 && idx + 1 < C.LESSONS.length) { startLesson(C.LESSONS[idx + 1]); return; }
    }
    leaveToTitle();
  }

  // ---------------------------------------------------------------- ticking

  function startTicking() {
    stopTicking();
    app.lastTickAt = performance.now();
    app.tickTimer = setInterval(function () {
      if (app.phase !== 'active' || app.paused || document.hidden) {
        app.lastTickAt = performance.now();
        return;
      }
      var now = performance.now();
      var dt = Math.floor(now - app.lastTickAt);
      app.lastTickAt = now;
      if (dt > 0 && app.session && app.session.state.status === 'active') {
        S.execute(app.session, { type: 'tick', elapsedMs: dt });
        updateHud();
      }
    }, 250);
    // Throttled presence heartbeat while actively playing (local dev server
    // only — the platform host has no client-reachable presence route).
    app.presenceTimer = setInterval(function () {
      if (app.phase === 'active' && !document.hidden && P.devApiAvailable()) {
        P.apiFetch('/api/v1/presence', { method: 'POST', body: { game: 'open-cells' } }).catch(function () {});
      }
    }, 30000);
  }

  function stopTicking() {
    if (app.tickTimer) clearInterval(app.tickTimer);
    if (app.presenceTimer) clearInterval(app.presenceTimer);
    app.tickTimer = 0; app.presenceTimer = 0;
  }

  function activity(kind) {
    if (P.devApiAvailable()) {
      P.apiFetch('/api/v1/activity', { method: 'POST', body: { event: kind } }).catch(function () {});
    }
  }

  // ---------------------------------------------------------------- session events

  function onSessionEvent(event, session) {
    var st = session.state;
    if (event.type === 'move') {
      var toZone = event.command.to ? event.command.to.zone : null;
      A.play(toZone === 'foundation' ? 'foundation' : toZone === 'cell' ? 'cell' : 'drop', st.seed + st.turn);
      if (toZone === 'foundation' && app.renderer) {
        app.renderer.playEvent('foundation', { loc: event.command.to });
      }
      clearSelection();
      syncViews(false);
      updateHud();
      updateMusic();
      saveSnapshotThrottled();
    } else if (event.type === 'invalid') {
      A.play('invalid');
      if (app.renderer) app.renderer.playEvent('invalid');
      app.ui.announce(event.message || 'That move is not legal.', true);
      toast(event.message || 'That move is not legal.');
      updateHud();
    } else if (event.type === 'undo') {
      A.play('undo');
      clearSelection();
      syncViews(false);
      updateHud();
      app.ui.announce('Undone.', false);
    } else if (event.type === 'lesson-step') {
      A.play('lesson-step');
      P.telemetry('tutorial-step', { index: event.index });
      if (event.done) lessonComplete();
      else showLessonStep();
      updateHud();
    } else if (event.type === 'terminal') {
      onTerminal();
    }
  }

  var snapshotSaveAt = 0;
  function saveSnapshotThrottled() {
    var now = Date.now();
    if (now - snapshotSaveAt > 2000) { snapshotSaveAt = now; saveSnapshot(); }
  }

  function updateMusic() {
    if (!app.session) return;
    var home = 0;
    app.session.state.foundations.forEach(function (f) { home += f.length; });
    A.setMusicIntensity(home / 52);
  }

  // ---------------------------------------------------------------- terminal

  function onTerminal() {
    var st = app.session.state;
    app.phase = 'results';
    stopTicking();
    activity('end');
    if (app.renderer) app.renderer.settle();

    var score = S.score(app.session);
    var won = st.status === 'won';
    var newlyUnlocked = [];

    // Progression bookkeeping.
    app.save.totals.played += 1;
    st.foundations.forEach(function (f) { app.save.totals.foundations += f.length; });
    if (won) app.save.totals.wins += 1;

    var stars = 0;
    if (app.config.mode === 'journey' && won) {
      var stg = app.config.journeyStage;
      stars = 1
        + (st.moves <= app.config.par.moves ? 1 : 0)
        + (st.elapsedMs <= app.config.par.timeMs ? 1 : 0);
      var prev = app.save.journey[stg.id];
      if (!prev || stars > prev.stars || score.total > prev.bestScore) {
        app.save.journey[stg.id] = {
          stars: Math.max(stars, prev ? prev.stars : 0),
          bestScore: Math.max(score.total, prev ? prev.bestScore : 0),
          bestMoves: prev ? Math.min(st.moves, prev.bestMoves) : st.moves,
          completedAt: new Date().toISOString()
        };
      }
    }

    if (app.config.mode === 'daily' && won) {
      var date = app.config.dealId.replace('daily-', '');
      var already = app.save.dailies[date];
      app.save.dailies[date] = { score: score.total, won: true, completedAt: new Date().toISOString() };
      if (!already) {
        var yesterday = new Date(P.now().getTime() - 86400000).toISOString().slice(0, 10);
        app.save.dailyStreak.count = (app.save.dailyStreak.lastDate === yesterday) ? app.save.dailyStreak.count + 1 : 1;
        app.save.dailyStreak.lastDate = date;
      }
    }

    // Score submission (ranked boards + casual practice board).
    var entry = {
      board: app.config.board || 'practice-local',
      dealId: app.config.dealId,
      seed: st.seed,
      ruleset: st.ruleset,
      contentVersion: C.CONTENT_VERSION,
      score: score,
      assists: { undo: st.undos, hints: 0 },
      durationMs: st.elapsedMs,
      moves: st.moves,
      invalid: st.invalid,
      sessionId: app.session.sessionId,
      at: new Date().toISOString(),
      // Ranked submissions carry the replay envelope so a host can validate.
      replay: app.config.ranked ? S.exportReplay(app.session) : undefined
    };
    if (won || app.config.ranked) P.submitScore(entry);

    // Achievements (idempotent).
    newlyUnlocked = checkAchievements(won);

    P.persistSave(app.save);
    clearSnapshot();

    if (won) { A.play('win'); if (app.renderer) app.renderer.playEvent('win'); }
    else A.play('lose');
    if (stars > 0) A.play('star', st.seed + stars);

    app.ui.showResults({
      status: st.status,
      reason: st.terminalReason,
      score: score,
      moves: st.moves,
      invalid: st.invalid,
      undos: st.undos,
      elapsedMs: st.elapsedMs,
      dealId: app.config.dealId,
      ranked: app.config.ranked,
      mode: app.config.mode,
      stars: stars,
      achievements: newlyUnlocked,
      onNextLabel: app.config.mode === 'journey' && won ? 'Next stage'
        : app.config.mode === 'learn' ? 'Next lesson' : null
    });
  }

  function unlock(key) {
    if (app.save.achievements[key]) return null;
    app.save.achievements[key] = new Date().toISOString();
    return C.ACHIEVEMENTS.find(function (a) { return a.key === key; });
  }

  function checkAchievements(won) {
    var out = [];
    function add(a) { if (a) { out.push(a); A.play('achievement'); } }
    if (won) add(unlock('first-completion'));
    if (C.LESSONS.every(function (l) { return app.save.lessons[l.id]; })) add(unlock('mechanic-mastery'));
    if (app.save.dailyStreak.count >= 3) add(unlock('daily-streak-3'));
    if (app.save.journey['journey-30']) add(unlock('journey-milestone-30'));
    if (app.save.totals.foundations >= 2600) add(unlock('long-game'));
    return out;
  }

  // ---------------------------------------------------------------- lessons

  function showLessonStep() {
    var ls = S.lessonState(app.session);
    if (!ls) return;
    var step = ls.def.steps[ls.stepIndex];
    updateHud();
    if (step) app.ui.announce('Lesson: ' + step.text, false);
  }

  function lessonComplete() {
    var ls = app.config.lesson;
    app.save.lessons[ls.id] = { completedAt: new Date().toISOString() };
    app.settings = P.updateSettings({ tutorialComplete: true });
    var newly = checkAchievements(false);
    P.persistSave(app.save);
    // Lessons end on their required action, not on a full clear — present
    // results directly without touching rules state (replay stays valid).
    app.phase = 'results';
    stopTicking();
    activity('end');
    var st = app.session.state;
    var score = S.score(app.session);
    clearSnapshot();
    A.play('win');
    if (app.renderer) app.renderer.playEvent('win');
    app.ui.showResults({
      status: 'won',
      reason: 'lesson-complete',
      score: score,
      moves: st.moves,
      invalid: st.invalid,
      undos: st.undos,
      elapsedMs: st.elapsedMs,
      dealId: app.config.dealId,
      ranked: false,
      mode: 'learn',
      stars: 0,
      achievements: newly,
      onNextLabel: 'Next lesson'
    });
  }

  // ---------------------------------------------------------------- input: selection & moves

  function movableSelection(loc, depth) {
    var st = app.session.state;
    if (loc.zone === 'cell') {
      if (st.cells[loc.index] === null) return null;
      return { loc: loc, count: 1, cardIds: [st.cells[loc.index]] };
    }
    if (loc.zone === 'foundation') {
      var f = st.foundations[loc.index];
      if (!f.length) return null;
      return { loc: loc, count: 1, cardIds: [f[f.length - 1]] };
    }
    var col = st.tableau[loc.index];
    if (!col.length) return null;
    var d = (depth == null) ? col.length - 1 : depth;
    var runStart = col.length - R.orderedRunLength(col);
    if (d < runStart) d = col.length - 1; // buried card: grab the movable top
    var count = col.length - d;
    return { loc: loc, count: count, cardIds: col.slice(d) };
  }

  function legalTargetsFor(sel) {
    if (!sel) return [];
    var seen = {};
    return R.enumerateActions(app.session.state)
      .filter(function (a) {
        return a.kind === 'move' && a.from.zone === sel.loc.zone && a.from.index === sel.loc.index &&
          (sel.loc.zone !== 'tableau' || a.count === sel.count);
      })
      .map(function (a) { return a.to; })
      .filter(function (to) {
        var k = to.zone + to.index;
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });
  }

  function select(sel, silent) {
    app.selection = sel;
    app.hintAction = null;
    var targets = legalTargetsFor(sel);
    if (app.renderer) {
      app.renderer.setSelection(sel ? sel.loc : null, sel ? sel.cardIds : []);
      app.renderer.setLegalTargets(targets);
    }
    if (!silent && sel) A.play('select', sel.cardIds[0]);
    refreshBoard();
    if (sel) {
      var id = sel.cardIds[0];
      var n = sel.cardIds.length;
      app.ui.announce('Selected ' + global.OCBoardDom.cardWords(id) + (n > 1 ? ' and ' + (n - 1) + ' more' : '') +
        '. ' + targets.length + ' legal target' + (targets.length === 1 ? '' : 's') + '.', false);
    }
  }

  function clearSelection() {
    app.selection = null;
    if (app.renderer) {
      app.renderer.setSelection(null, []);
      app.renderer.clearLegalTargets();
    }
  }

  function attemptMove(from, to, count) {
    if (!app.session || app.session.state.status !== 'active') return;
    if (!to) { select(null, true); A.play('deselect'); refreshBoard(); return; }
    // Dropping a card back onto its own pile is a cancel, not an invalid
    // attempt — it must not cost score or bump the invalid counter.
    if (from.zone === to.zone && from.index === to.index) {
      select(null, true);
      refreshBoard();
      return;
    }
    var r = S.execute(app.session, { id: cmdId(), type: 'move', from: from, to: to, count: count || 1 });
    if (r.ok) {
      haptic(15);
      clearSelection();
    }
  }

  function haptic(ms) {
    if (app.settings.haptics && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} }
  }

  // Canvas pointer intents from the renderer.
  function onPointerAction(a) {
    if (!app.session || app.phase !== 'active' || app.paused) return;
    if (app.session.state.status !== 'active') return;
    A.unlock();
    var st = app.session.state;

    if (a.type === 'tap-card') {
      var loc = app.renderer.cardLocOf(a.cardId);
      if (!loc) return;
      handleCardPress(loc, a.cardId);
    } else if (a.type === 'press-slot') {
      if (app.selection) attemptMove(app.selection.loc, a.loc, app.selection.count);
    } else if (a.type === 'drop') {
      var from = app.renderer.cardLocOf(a.cardId);
      if (!from) return;
      attemptMove(from, a.to, a.cardIds ? a.cardIds.length : 1);
    } else if (a.type === 'drag-start') {
      A.play('pickup', a.cardId);
    } else if (a.type === 'drag-cancel') {
      refreshBoard();
    }
  }

  // Shared press logic for canvas taps and DOM-board clicks.
  function handleCardPress(loc, cardId, depth) {
    var now = performance.now();
    var doubleTap = app.lastTap.cardId === cardId && (now - app.lastTap.at) < 400;
    app.lastTap = { cardId: cardId, at: now };

    if (app.selection) {
      var sel = app.selection;
      // Tapping the selection itself toggles off.
      if (sel.loc.zone === loc.zone && sel.loc.index === loc.index) {
        if (doubleTap) { smartMove(sel); return; }
        select(null, true); A.play('deselect'); refreshBoard();
        return;
      }
      // Tapping a legal target commits.
      var targets = legalTargetsFor(sel);
      var hit = targets.find(function (t) { return t.zone === loc.zone && t.index === loc.index; });
      if (hit) { attemptMove(sel.loc, hit, sel.count); return; }
      // Otherwise move selection to the new card.
    }
    if (doubleTap && app.selection) { smartMove(app.selection); return; }
    var newSel = movableSelection(loc, depth);
    if (newSel) select(newSel);
  }

  // Double-tap / double-click: foundation first, then any free cell.
  function smartMove(sel) {
    var st = app.session.state;
    var id = sel.cardIds[sel.cardIds.length - 1];
    if (sel.count === 1 && R.canPlaceOnFoundation(st, id)) {
      attemptMove(sel.loc, { zone: 'foundation', index: R.suitOf(id) }, 1);
      return;
    }
    if (sel.loc.zone === 'tableau') {
      for (var i = 0; i < R.NUM_CELLS; i++) {
        if (i < st.constraints.cellsAvailable && st.cells[i] === null) {
          attemptMove(sel.loc, { zone: 'cell', index: i }, 1);
          return;
        }
      }
    }
    select(null, true);
    refreshBoard();
  }

  function onDomCard(loc, depth) {
    if (!app.session || app.phase !== 'active' || app.paused) return;
    A.unlock();
    var st = app.session.state;
    var id = null;
    if (loc.zone === 'cell') id = st.cells[loc.index];
    else if (loc.zone === 'foundation') { var f = st.foundations[loc.index]; id = f[f.length - 1]; }
    else id = st.tableau[loc.index][depth];
    if (id == null) { onDomSlot(loc); return; }
    handleCardPress(loc, id, depth);
  }

  function onDomSlot(loc) {
    if (!app.session || app.phase !== 'active' || app.paused) return;
    A.unlock();
    if (app.selection) attemptMove(app.selection.loc, loc, app.selection.count);
  }

  // ---------------------------------------------------------------- views

  function syncViews(instant) {
    var st = app.session.state;
    if (app.renderer) app.renderer.syncState(st, { instant: !!instant });
    refreshBoard();
  }

  function refreshBoard() {
    if (!app.board || !app.session) return;
    app.board.render(app.session.state, app.selection,
      app.selection ? legalTargetsFor(app.selection) : [], app.hintAction);
  }

  function updateHud() {
    if (!app.session) return;
    var st = app.session.state;
    var home = 0;
    st.foundations.forEach(function (f) { home += f.length; });
    var score = S.score(app.session);
    var lesson = S.lessonState(app.session);
    app.ui.updateHud({
      objective: objectiveText(),
      progress: home + ' / 52 home',
      moves: st.moves + ' moves' + (st.constraints.moveLimit ? ' / ' + st.constraints.moveLimit : ''),
      time: global.OCUi.fmtTime(st.elapsedMs) + (st.constraints.timeLimitMs ? ' / ' + global.OCUi.fmtTime(st.constraints.timeLimitMs) : ''),
      score: String(score.total),
      deal: app.config.dealId,
      undoCount: String(app.session.undoStack.length),
      lessonText: lesson && lesson.stepIndex < lesson.total
        ? 'Lesson ' + (lesson.stepIndex + 1) + '/' + lesson.total + ': ' + lesson.def.steps[lesson.stepIndex].text
        : (lesson ? 'Lesson complete.' : '')
    });
  }

  function toast(msg) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  // ---------------------------------------------------------------- actions (HUD)

  function doUndo() {
    if (!app.session || app.phase !== 'active' || app.paused) return;
    S.execute(app.session, { id: cmdId(), type: 'undo' });
  }

  function doHint() {
    if (!app.session || app.phase !== 'active' || app.paused) return;
    var h = S.hint(app.session);
    if (!h) { app.ui.announce('No moves available.', true); return; }
    app.hintAction = h;
    A.play('hint');
    refreshBoard();
    if (app.renderer) {
      app.renderer.setLegalTargets([h.to]);
      app.renderer.setSelection(h.from, []);
    }
    var id = h.from.zone === 'cell' ? app.session.state.cells[h.from.index]
      : h.from.zone === 'foundation' ? null
      : R.topOfColumn(app.session.state, h.from.index);
    app.ui.announce('Hint: move ' + (id != null ? global.OCBoardDom.cardWords(id) : 'a card') +
      ' to ' + h.to.zone + ' ' + (h.to.index + 1) + '.', false);
  }

  function doAuto() {
    if (!app.session || app.phase !== 'active' || app.paused) return;
    S.execute(app.session, { id: cmdId(), type: 'auto' });
  }

  function doPause() {
    if (app.phase === 'active' && !app.paused) {
      app.paused = true;
      app.phase = 'paused';
      saveSnapshot();
      A.suspend();
      app.ui.showPause();
    } else if (app.phase === 'paused') {
      resumeGame();
    }
  }

  function resumeGame() {
    if (app.phase !== 'paused') return;
    app.paused = false;
    app.phase = 'active';
    A.resume();
    app.lastTickAt = performance.now();
  }

  function doConcede() {
    if (!app.session || app.phase !== 'active' || app.paused) return;
    if (app.session.state.status !== 'active') return;
    if (global.confirm('Concede this deal?')) {
      S.execute(app.session, { id: cmdId(), type: 'concede' });
    }
  }

  function wireHudButtons() {
    function bind(sel, fn) { var b = $(sel); if (b) b.addEventListener('click', function () { A.unlock(); fn(); }); }
    bind('#btn-undo', doUndo);
    bind('#btn-hint', doHint);
    bind('#btn-auto', doAuto);
    bind('#btn-pause', doPause);
    bind('#btn-concede', doConcede);
    bind('#btn-restart', function () {
      if (global.confirm('Restart this deal from the beginning?')) retryDeal();
    });
    bind('#btn-menu', function () {
      if (app.phase === 'active' || app.phase === 'paused') doPause();
      else showTitle();
    });
    bind('#btn-skip-anim', function () { if (app.renderer) app.renderer.settle(); });
  }

  // ---------------------------------------------------------------- global input

  function wireGlobalInput() {
    document.addEventListener('keydown', function (ev) {
      // Ignore shortcuts while typing in a form field.
      if (ev.target && /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
      if (app.ui.hasOpenScreen()) return; // overlays handle their own keys
      var kb = app.settings.keybindings;
      var code = ev.code;
      if (code === kb.undo) { ev.preventDefault(); doUndo(); }
      else if (code === kb.hint) { ev.preventDefault(); doHint(); }
      else if (code === kb.auto) { ev.preventDefault(); doAuto(); }
      else if (code === kb.cameraReset) { if (app.renderer) app.renderer.resetCamera(); }
      else if (code === 'Escape') {
        if (app.selection) { select(null, true); A.play('deselect'); refreshBoard(); }
        else doPause();
      }
      else if (code === 'KeyP') doPause();
    });

    // Gamepad: focus navigation + confirm/cancel/pause (default mapping;
    // keyboard bindings are declared in settings).
    var padState = { buttons: [], axes: [0, 0], repeatAt: 0 };
    setInterval(function () {
      if (!navigator.getGamepads) return;
      var pads = navigator.getGamepads();
      var gp = null;
      for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
      if (!gp) return;
      var now = performance.now();
      function pressed(idx) {
        var down = gp.buttons[idx] && gp.buttons[idx].pressed;
        var was = padState.buttons[idx];
        padState.buttons[idx] = down;
        return down && !was;
      }
      // A=0 confirm, B=1 cancel, Start=9 pause, dpad 12-15 nav.
      if (pressed(0)) {
        A.unlock();
        var ae = document.activeElement;
        if (ae && ae.click && $('#dom-board') && $('#dom-board').contains(ae)) ae.click();
        else if (app.board && app.phase === 'active') app.board.focusFirst();
      }
      if (pressed(1)) {
        if (app.selection) { select(null, true); refreshBoard(); }
        else if (app.ui.hasOpenScreen()) app.ui.closeTop();
      }
      if (pressed(9)) doPause();
      var dirs = [[14, 'ArrowLeft'], [15, 'ArrowRight'], [12, 'ArrowUp'], [13, 'ArrowDown']];
      dirs.forEach(function (d) {
        if (pressed(d[0]) || (gp.buttons[d[0]] && gp.buttons[d[0]].pressed && now > padState.repeatAt)) {
          padState.repeatAt = now + 180;
          var ev = new KeyboardEvent('keydown', { key: d[1], bubbles: true });
          var ae = document.activeElement;
          (ae && ae !== document.body ? ae : document).dispatchEvent(ev);
          if (ae === document.body || !ae) { if (app.board) app.board.focusFirst(); }
        }
      });
    }, 60);
  }

  // ---------------------------------------------------------------- lifecycle

  function wireLifecycle() {
    // Backgrounding pauses the solo simulation and the renderer heartbeat.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (app.phase === 'active' && !app.paused) {
          app.paused = true;
          app.phase = 'paused';
          saveSnapshot();
          app.ui.showPause();
        }
        if (app.renderer) app.renderer.stop();
        A.suspend();
      } else {
        if (app.renderer) app.renderer.start();
        app.lastTickAt = performance.now();
        // Stay paused; the player resumes deliberately from the pause screen.
      }
    });

    global.addEventListener('resize', function () {
      if (app.renderer) app.renderer.resize();
    });
    global.addEventListener('orientationchange', function () {
      setTimeout(function () { if (app.renderer) app.renderer.resize(); }, 120);
    });
    global.addEventListener('beforeunload', function () {
      saveSnapshot();
      activity('end');
    });
  }

  // ---------------------------------------------------------------- settings

  function applySettings(s) {
    app.settings = s;
    app.ui.applySettings(s);
    A.setVolumes(s.volume);
    A.setMuted(s.muted);
    if (app.renderer) {
      app.renderer.setReducedMotion(s.reducedMotion);
      app.renderer.setGraphics(graphicsSettings());
      app.renderer.setTheme(currentTheme());
    }
    // HTML mode can be toggled at runtime; it only takes effect next load for
    // the canvas, but the DOM board visibility flips immediately.
    document.body.classList.toggle('html-mode', !!s.htmlMode || !app.use3d);
    if (!app.use3d && !s.htmlMode && global.OCRender.isSupported()) {
      // Player turned 3D back on: reload to rebuild the scene cleanly.
      global.location.reload();
    }
  }

  function wipeAll() {
    try {
      localStorage.removeItem('open-cells/save/v1');
      localStorage.removeItem('open-cells/settings/v1');
      localStorage.removeItem('open-cells/boards/v1');
    } catch (e) {}
    P.wipeCloudSave();
    global.location.reload();
  }

  // ---------------------------------------------------------------- go

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof self !== 'undefined' ? self : this);
