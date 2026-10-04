/*
 * Open Cells — UI layer.
 * Responsive DOM shell: screens and overlays, HUD, focus management with
 * restoration, live-region announcements, settings binding, results and
 * progress presentation. All menus/forms/text are semantic HTML; the canvas
 * is never the only UI. Browser only. Exposes window.OCUi.
 */
(function (global) {
  'use strict';

  var R = global.OCRules;
  var C = global.OCContent;
  var P = global.OCPlatform;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(label, cls, onClick) {
    var b = el('button', cls || 'btn', label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function fmtDuration(ms) {
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  // ---------------------------------------------------------------- ui shell

  function createUi(root, actions) {
    var screensEl = root.querySelector('#screens');
    var liveEl = root.querySelector('#live');
    var liveAssertiveEl = root.querySelector('#live-assertive');
    var openStack = [];       // stack of open overlay screens for focus restore
    var lastFocus = [];

    function announce(text, assertive) {
      var target = assertive ? liveAssertiveEl : liveEl;
      target.textContent = '';
      // Reassign after a tick so repeated identical announcements are read.
      setTimeout(function () { target.textContent = text; }, 30);
    }

    // ------------------------------------------------------------ screen mgmt

    function closeTop() {
      var top = openStack.pop();
      if (!top) return;
      top.remove();
      var restore = lastFocus.pop();
      if (restore && document.contains(restore)) restore.focus();
    }

    function closeAll() { while (openStack.length) closeTop(); }

    function openScreen(name, buildFn, opts) {
      opts = opts || {};
      lastFocus.push(document.activeElement);
      var overlay = el('div', 'screen-overlay');
      overlay.dataset.screen = name;
      var dialog = el('div', 'screen ' + (opts.wide ? 'screen-wide' : ''));
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      var heading = el('h2', 'screen-title', opts.title || name);
      heading.tabIndex = -1;
      dialog.appendChild(heading);
      // Every overlay carries a persistent 44px Close control (touch-reachable
      // dismissal), alongside Escape and outside taps.
      if (!opts.noEscape) {
        var closeBtn = button('✕', 'btn btn-ghost screen-close', function () {
          closeTop();
          if (actions.onOverlayClosed) actions.onOverlayClosed(name);
        });
        closeBtn.setAttribute('aria-label', 'Close ' + (opts.title || name));
        dialog.appendChild(closeBtn);
        overlay.addEventListener('click', function (ev) {
          if (ev.target === overlay) { closeTop(); if (actions.onOverlayClosed) actions.onOverlayClosed(name); }
        });
      }
      var body = el('div', 'screen-body');
      dialog.appendChild(body);
      overlay.appendChild(dialog);
      buildFn(body, dialog);
      if (!opts.noEscape && name === 'help') {
        body.appendChild(button('Back', 'btn btn-primary', function () { closeTop(); if (actions.onOverlayClosed) actions.onOverlayClosed(name); }));
      }
      screensEl.appendChild(overlay);
      openStack.push(overlay);

      overlay.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && !opts.noEscape) {
          ev.stopPropagation();
          closeTop();
          if (actions.onOverlayClosed) actions.onOverlayClosed(name);
        }
        // Simple focus trap: keep Tab inside the dialog.
        if (ev.key === 'Tab') {
          var focusables = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (!focusables.length) return;
          var first = focusables[0], last = focusables[focusables.length - 1];
          if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
          else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
        }
      });
      heading.focus();
      return { overlay: overlay, dialog: dialog, body: body, close: closeTop };
    }

    // ------------------------------------------------------------ title

    function showTitle(data) {
      openScreen('title', function (body) {
        var hero = el('div', 'title-hero');
        hero.appendChild(el('div', 'title-wordmark', 'Open Cells'));
        hero.appendChild(el('p', 'title-tag', 'A brass-and-slate card puzzle. Four cells. Fifty-two cards. No hidden information.'));
        body.appendChild(hero);

        var play = button(data.hasSnapshot ? 'Continue' : 'Play', 'btn btn-primary btn-play', function () {
          closeAll(); actions.onPlay();
        });
        body.appendChild(play);

        var row = el('div', 'title-row');
        row.appendChild(button('Daily Deal', 'btn', function () { closeAll(); actions.onDaily(); }));
        row.appendChild(button('Journey', 'btn', function () { showJourney(data); }));
        row.appendChild(button('Modes', 'btn', function () { showModes(data); }));
        body.appendChild(row);

        var row2 = el('div', 'title-row title-row-quiet');
        row2.appendChild(button('Learn', 'btn btn-quiet', function () { showLearn(data); }));
        row2.appendChild(button('Scores', 'btn btn-quiet', function () { showBoards(); }));
        row2.appendChild(button('Settings', 'btn btn-quiet', function () { showSettings(); }));
        row2.appendChild(button('Help', 'btn btn-quiet', function () { showHelp(); }));
        body.appendChild(row2);

        // StarHermit account: sign-in only where the platform offers it,
        // invite only when signed in.
        var acct = data.account || {};
        if (acct.signIn || acct.invite) {
          var tr = global.OCGfx.strings(global.navigator && navigator.language);
          var row3 = el('div', 'title-row title-row-quiet title-account');
          row3.lang = global.OCGfx.pickLocale(global.navigator && navigator.language);
          if (acct.signIn) {
            var si = button(tr('sh_signIn'), 'btn', function () { actions.onSignIn(); });
            si.id = 'btn-sh-sign-in';
            row3.appendChild(si);
          }
          if (acct.invite) {
            var inv = button(tr('sh_invite'), 'btn', function () { actions.onInvite(); });
            inv.id = 'btn-sh-invite';
            row3.appendChild(inv);
          }
          body.appendChild(row3);
        }

        if (data.journeyDone != null) {
          body.appendChild(el('p', 'title-progress',
            'Journey: ' + data.journeyDone + ' of ' + C.JOURNEY.length + ' stages · Daily streak: ' + data.dailyStreak));
        }
        body.appendChild(el('p', 'title-clock', 'Daily deal: ' + data.dailyId + ' · next in ' + fmtDuration(data.msToNextDaily)));
      }, { title: 'Open Cells' });
    }

    // ------------------------------------------------------------ modes

    var MODE_CARDS = [
      { id: 'learn', title: 'Learn', desc: 'Six short lessons. One rule at a time; you perform each move.', duration: '2 min each', ranked: false },
      { id: 'journey', title: 'Journey', desc: 'Forty authored stages. New constraints arrive one at a time, with mastery checks.', duration: '5–10 min', ranked: true },
      { id: 'daily', title: 'Daily', desc: 'One shared deal per UTC day. Same seed for everyone.', duration: '~8 min', ranked: true },
      { id: 'practice', title: 'Practice', desc: 'Pick a difficulty. Free undo, restart any time, never ranked.', duration: 'any', ranked: false },
      { id: 'challenge', title: 'Challenge', desc: 'Constrained deals: move limits, clocks, fewer cells.', duration: '5–10 min', ranked: true },
      { id: 'chase', title: 'Score Chase', desc: 'Seeded deals compared on the boards. Validate your replay, climb the list.', duration: '~8 min', ranked: true }
    ];

    function showModes(data) {
      openScreen('modes', function (body) {
        var grid = el('div', 'mode-grid');
        MODE_CARDS.forEach(function (m) {
          var card = el('div', 'mode-card');
          card.appendChild(el('h3', null, m.title));
          card.appendChild(el('p', null, m.desc));
          var meta = el('p', 'mode-meta', m.duration + ' · ' + (m.ranked ? 'Ranked' : 'Unranked'));
          card.appendChild(meta);
          card.appendChild(button('Open', 'btn btn-primary', function () {
            closeAll();
            actions.onMode(m.id);
          }));
          grid.appendChild(card);
        });
        body.appendChild(grid);
      }, { title: 'Choose a mode', wide: true });
    }

    // ------------------------------------------------------------ journey

    function showJourney(data) {
      openScreen('journey', function (body) {
        body.appendChild(el('p', null, 'Complete a stage to unlock the next. Mastery stages combine everything before them.'));
        var grid = el('div', 'journey-grid');
        C.JOURNEY.forEach(function (st) {
          var rec = data.journey[st.id];
          var unlocked = st.n === 1 || data.journey[C.JOURNEY[st.n - 2].id];
          var cell = button('', 'journey-cell' + (rec ? ' done' : '') + (st.mastery ? ' mastery' : '') + (!unlocked ? ' locked' : ''), null);
          cell.disabled = !unlocked;
          var stars = rec ? '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars) : '';
          cell.innerHTML = '<span class="journey-n">' + st.n + '</span><span class="journey-stars">' + stars + '</span>';
          cell.setAttribute('aria-label', 'Stage ' + st.n + ': ' + st.title + (rec ? ', completed, ' + rec.stars + ' of 3 stars' : unlocked ? ', unlocked' : ', locked'));
          if (unlocked) {
            cell.addEventListener('click', function () { showStageSetup(st); });
          }
          grid.appendChild(cell);
        });
        body.appendChild(grid);
      }, { title: 'Journey', wide: true });
    }

    function constraintSummary(cons) {
      var parts = [];
      if (cons.cellsAvailable < 4) parts.push(cons.cellsAvailable + ' cells');
      if (cons.moveLimit) parts.push('≤ ' + cons.moveLimit + ' moves');
      if (cons.timeLimitMs) parts.push('≤ ' + fmtTime(cons.timeLimitMs));
      if (cons.noAuto) parts.push('no auto-collect');
      return parts.length ? parts.join(' · ') : 'standard rules';
    }

    function showStageSetup(st) {
      openScreen('stage-setup', function (body, dialog) {
        body.appendChild(el('p', null, 'Difficulty ' + '●'.repeat(st.difficulty) + '○'.repeat(5 - st.difficulty)));
        body.appendChild(el('p', null, 'Rules: ' + constraintSummary(st.constraints)));
        body.appendChild(el('p', null, 'Par: ' + st.par.moves + ' moves, ' + fmtTime(st.par.timeMs) + '. Seed ' + st.seed + '. Ranked.'));
        if (st.tutorialFlags.length) body.appendChild(el('p', null, 'Concept focus: ' + st.tutorialFlags.join(', ')));
        body.appendChild(button('Begin stage', 'btn btn-primary', function () {
          closeAll(); actions.onStartJourney(st);
        }));
        body.appendChild(button('Back', 'btn btn-quiet', function () { closeTop(); }));
      }, { title: 'Stage ' + st.n + ' — ' + st.title });
    }

    // ------------------------------------------------------------ learn

    function showLearn(data) {
      openScreen('learn', function (body) {
        body.appendChild(el('p', null, 'Lessons ask you to perform each rule yourself. Progress is saved.'));
        C.LESSONS.forEach(function (ls, i) {
          var done = data.lessons[ls.id];
          var rowEl = el('div', 'lesson-row');
          rowEl.appendChild(el('span', 'lesson-status', done ? '✓' : (i + 1) + '.'));
          var txt = el('div', 'lesson-text');
          txt.appendChild(el('strong', null, ls.title));
          txt.appendChild(el('p', null, ls.intro));
          rowEl.appendChild(txt);
          rowEl.appendChild(button(done ? 'Replay' : 'Start', 'btn', function () {
            closeAll(); actions.onStartLesson(ls);
          }));
          body.appendChild(rowEl);
        });
      }, { title: 'Learn', wide: true });
    }

    // ------------------------------------------------------------ setup screens

    function showPracticeSetup() {
      openScreen('practice-setup', function (body) {
        body.appendChild(el('p', null, 'Practice is never ranked. Undo is free; restart any time.'));
        C.PRACTICE_DIFFICULTIES.forEach(function (d) {
          var rowEl = el('div', 'lesson-row');
          var txt = el('div', 'lesson-text');
          txt.appendChild(el('strong', null, d.title));
          txt.appendChild(el('p', null, d.description + ' (' + constraintSummary(d.constraints) + ')'));
          rowEl.appendChild(txt);
          rowEl.appendChild(button('Deal', 'btn btn-primary', function () {
            closeAll(); actions.onStartPractice(d);
          }));
          body.appendChild(rowEl);
        });
      }, { title: 'Practice' });
    }

    function showChallengeSetup() {
      openScreen('challenge-setup', function (body) {
        body.appendChild(el('p', null, 'Constrained deals. Your score goes to the challenge boards.'));
        C.CHALLENGES.forEach(function (ch) {
          var rowEl = el('div', 'lesson-row');
          var txt = el('div', 'lesson-text');
          txt.appendChild(el('strong', null, ch.title + '  ' + '●'.repeat(ch.difficulty)));
          txt.appendChild(el('p', null, ch.description + ' (' + constraintSummary(ch.constraints) + ')'));
          rowEl.appendChild(txt);
          rowEl.appendChild(button('Play', 'btn btn-primary', function () {
            closeAll(); actions.onStartChallenge(ch);
          }));
          body.appendChild(rowEl);
        });
      }, { title: 'Challenge', wide: true });
    }

    function showDailySetup(daily, clockMode) {
      openScreen('daily-setup', function (body) {
        body.appendChild(el('p', null, 'Deal ' + daily.date + ' · seed ' + daily.seed + ' · standard rules · par ' + daily.par.moves + ' moves.'));
        body.appendChild(el('p', null, clockMode === 'synced'
          ? 'Clock synchronized with StarHermit.'
          : 'Using this device’s clock for the daily boundary.'));
        body.appendChild(el('p', null, 'One result per day counts for your streak. Ranked.'));
        body.appendChild(button('Play today’s deal', 'btn btn-primary', function () {
          closeAll(); actions.onStartDaily(daily);
        }));
      }, { title: 'Daily Deal' });
    }

    function showChaseSetup() {
      openScreen('chase-setup', function (body) {
        body.appendChild(el('p', null, 'Enter a seed (or roll one). Everyone with the same seed plays the same deal; results go to the seed board.'));
        var form = el('form', 'chase-form');
        var input = el('input');
        input.type = 'text'; input.name = 'seed'; input.placeholder = 'e.g. brass-owl-42';
        input.setAttribute('aria-label', 'Challenge seed');
        input.maxLength = 40;
        form.appendChild(input);
        var submitBtn = button('Play seed', 'btn btn-primary', null);
        submitBtn.type = 'submit';
        form.appendChild(submitBtn);
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var v = input.value.trim() || ('roll-' + Math.floor(Math.random() * 1e9).toString(36));
          closeAll(); actions.onStartChase(v);
        });
        body.appendChild(form);
        body.appendChild(button('Roll a random seed', 'btn', function () {
          closeAll(); actions.onStartChase('roll-' + Math.floor(Math.random() * 1e9).toString(36));
        }));
      }, { title: 'Score Chase' });
    }

    // ------------------------------------------------------------ pause

    function showPause() {
      openScreen('pause', function (body) {
        body.appendChild(button('Resume', 'btn btn-primary', function () {
          closeTop(); actions.onResume();
        }));
        body.appendChild(button('Restart deal', 'btn', function () {
          closeAll(); actions.onRetry();
        }));
        body.appendChild(button('Settings', 'btn', function () { showSettings(); }));
        body.appendChild(button('Help', 'btn', function () { showHelp(); }));
        body.appendChild(button('Leave deal', 'btn btn-quiet', function () {
          closeAll(); actions.onLeave();
        }));
      }, { title: 'Paused' });
    }

    // ------------------------------------------------------------ settings

    function showSettings() {
      var settings = P.getSettings();
      openScreen('settings', function (body, dialog) {
        function group(title) {
          var g = el('section', 'settings-group');
          g.appendChild(el('h3', null, title));
          body.appendChild(g);
          return g;
        }
        function toggle(parent, key, label, desc) {
          var wrap = el('label', 'setting-toggle');
          var input = el('input');
          input.type = 'checkbox';
          input.checked = !!settings[key];
          input.addEventListener('change', function () {
            settings = P.updateSettings({ [key]: input.checked });
            actions.onSettingsChanged(settings);
          });
          wrap.appendChild(input);
          var t = el('span', null);
          t.appendChild(el('strong', null, label));
          if (desc) t.appendChild(el('small', null, desc));
          wrap.appendChild(t);
          parent.appendChild(wrap);
        }
        function slider(parent, bus, label) {
          var wrap = el('label', 'setting-slider');
          wrap.appendChild(el('span', null, label));
          var input = el('input');
          input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.05';
          input.value = String(settings.volume[bus]);
          input.setAttribute('aria-label', label + ' volume');
          input.addEventListener('input', function () {
            settings = P.updateSettings({ volume: { [bus]: parseFloat(input.value) } });
            actions.onSettingsChanged(settings);
          });
          wrap.appendChild(input);
          parent.appendChild(wrap);
        }
        function select(parent, key, label, options) {
          var wrap = el('label', 'setting-select');
          wrap.appendChild(el('span', null, label));
          var sel = el('select');
          sel.setAttribute('aria-label', label);
          options.forEach(function (o) {
            var opt = el('option', null, o.label);
            opt.value = o.value;
            if (settings[key] === o.value) opt.selected = true;
            sel.appendChild(opt);
          });
          sel.addEventListener('change', function () {
            settings = P.updateSettings({ [key]: sel.value });
            actions.onSettingsChanged(settings);
          });
          wrap.appendChild(sel);
          parent.appendChild(wrap);
        }

        var ga = group('Audio');
        slider(ga, 'music', 'Music');
        slider(ga, 'effects', 'Effects');
        slider(ga, 'ambience', 'Ambience');
        slider(ga, 'voice', 'Interface cues');
        toggle(ga, 'muted', 'Mute all', 'Silence every bus at once.');

        var gg = group('Graphics');
        select(gg, 'theme', 'Theme', C.THEMES.map(function (t) { return { value: t.id, label: t.name }; }));
        toggle(gg, 'reducedMotion', 'Reduced motion', 'Removes camera moves, shake, particles, and large scaling.');
        buildGraphics(gg);

        var gx = group('Accessibility');
        toggle(gx, 'highContrast', 'High contrast', 'Stronger outlines and text contrast.');
        toggle(gx, 'largerText', 'Larger text', 'Increases UI text size.');
        select(gx, 'colorPalette', 'Suit color palette', [
          { value: 'standard', label: 'Standard red/black' },
          { value: 'deuteranopia', label: 'Deuteranopia-safe (blue/orange)' },
          { value: 'tritanopia', label: 'Tritanopia-safe (blue/red)' }
        ]);
        toggle(gx, 'leftHanded', 'Left-handed layout', 'Mirrors the action tray.');
        toggle(gx, 'holdToDrag', 'Hold to drag', 'Require holding a card to drag; tap toggles selection otherwise.');
        toggle(gx, 'haptics', 'Haptics', 'Vibration feedback on supporting devices.');
        toggle(gx, 'htmlMode', 'HTML board', 'Use the semantic HTML board instead of the 3D scene.');

        var gc = group('Controls');
        var k = actions.keyText;
        var kb = el('p', null, 'Keyboard: ' + [k('navLeft'), k('navRight'), k('navUp'), k('navDown')].join(' ') + ' navigate, Enter/Space select or place, ' +
          k('cancel') + ' cancel/pause, ' + k('pause') + ' pause, ' + k('undo') + ' undo, ' + k('hint') + ' hint, ' + k('auto') + ' collect, ' +
          k('restart') + ' restart, ' + k('cameraReset') + ' camera reset.');
        gc.appendChild(kb);
        var gp = el('p', null, 'Gamepad: stick or D-pad navigates, A confirms, B cancels, Start pauses.');
        gc.appendChild(gp);

        var gd = group('Data');
        var wipe = button('Erase local progress', 'btn btn-quiet', function () {
          if (global.confirm('Erase all local progress, scores, and settings?')) actions.onWipe();
        });
        gd.appendChild(wipe);

        body.appendChild(button('Done', 'btn btn-primary', function () { closeTop(); }));
      }, { title: 'Settings', wide: true });
    }

    // ------------------------------------------------------------ graphics

    // Graphics quality controls (preset, render scale, per-effect overrides,
    // adaptive resolution, frame-rate readout, cost summary). Strings come
    // from OCGfx in the browser's language; ids are stable for tests.
    function buildGraphics(parent) {
      var G = global.OCGfx;
      var t = G.strings(global.navigator && navigator.language);
      var box = el('div', 'gfx-settings');
      box.id = 'gfx-settings';
      parent.appendChild(box);

      function saved() {
        var st = P.getSettings();
        return st.graphics || G.fromLegacy(st.quality);
      }
      function save(g) {
        var st = P.updateSettings({ graphics: g });
        actions.onSettingsChanged(st);
      }
      function info() { return actions.graphicsInfo ? actions.graphicsInfo() : null; }

      function selectRow(id, label, options, value, onChange) {
        var wrap = el('label', 'setting-select');
        wrap.appendChild(el('span', null, label));
        var sel = el('select');
        sel.id = id;
        sel.setAttribute('aria-label', label);
        options.forEach(function (o) {
          var opt = el('option', null, o.label);
          opt.value = o.value;
          if (o.value === value) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', function () { onChange(sel.value); });
        wrap.appendChild(sel);
        box.appendChild(wrap);
        return sel;
      }
      function toggleRow(id, label, desc, checked, onChange) {
        var wrap = el('label', 'setting-toggle');
        var input = el('input');
        input.type = 'checkbox';
        input.id = id;
        input.checked = !!checked;
        input.addEventListener('change', function () { onChange(input.checked); });
        wrap.appendChild(input);
        var sp = el('span', null);
        sp.appendChild(el('strong', null, label));
        if (desc) sp.appendChild(el('small', null, desc));
        wrap.appendChild(sp);
        box.appendChild(wrap);
      }

      var summaryEl = null, noteEl = null;
      function refreshSummary() {
        if (!summaryEl) return;
        var inf = info();
        var r = inf ? inf.resolved : G.resolve(saved(), 'balanced');
        var gpu = inf && inf.gpu ? inf.gpu : t('unknownGpu');
        summaryEl.textContent = gpu + ' · ' + G.describe(r, inf ? inf.pixels : null, t) +
          (inf && r.showFps && inf.fps ? ' · ' + inf.fps + ' fps' : '');
        summaryEl.dataset.preset = r.preset;
        var msg = !inf ? t('noScene') : (inf.postFailed && r.post ? t('postFailed') : '');
        noteEl.textContent = msg;
        noteEl.hidden = !msg;
      }

      function render(focusId) {
        box.textContent = '';
        var s = saved();
        var inf = info();
        var detected = inf ? inf.detected : 'balanced';
        var r = G.resolve(s, detected);
        box.dataset.preset = r.preset;

        var presetOpts = [{ value: 'auto', label: t('auto', t(detected)) }].concat(
          G.PRESETS.map(function (p) { return { value: p, label: t(p) }; }));
        selectRow('gfx-preset', t('quality'), presetOpts, r.auto ? 'auto' : r.preset, function (v) {
          save(G.choosePreset(saved(), v)); // choosing a preset clears overrides
          render('gfx-preset');
        });

        var sw = el('label', 'setting-slider gfx-scale');
        sw.appendChild(el('span', null, t('renderScale')));
        var range = el('input');
        range.type = 'range'; range.min = '50'; range.max = '200'; range.step = '10';
        range.id = 'gfx-scale';
        range.value = String(Math.round(r.renderScale * 100));
        range.setAttribute('aria-label', t('renderScale'));
        var out = el('output', 'gfx-scale-value', range.value + '%');
        out.id = 'gfx-scale-value';
        range.addEventListener('input', function () { out.textContent = range.value + '%'; });
        range.addEventListener('change', function () {
          var g = Object.assign({}, saved(), { render_scale: parseInt(range.value, 10) / 100 });
          save(g);
          refreshSummary();
        });
        sw.appendChild(range);
        sw.appendChild(out);
        box.appendChild(sw);

        Object.keys(G.CATEGORIES).forEach(function (cat) {
          var opts = [{ value: 'preset', label: t('fromPreset', t('t_' + G.presetTier(r.preset, cat))) }].concat(
            G.CATEGORIES[cat].map(function (tier) { return { value: tier, label: t('t_' + tier) }; }));
          var cur = G.CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : 'preset';
          var sel = selectRow('gfx-' + cat, t('cat_' + cat), opts, cur, function (v) {
            var g = Object.assign({}, saved());
            if (v === 'preset') delete g[cat]; else g[cat] = v;
            save(g);
            refreshSummary();
          });
          sel.dataset.gfxCategory = cat;
        });

        toggleRow('gfx-adaptive', t('adaptive'), t('adaptiveDesc'), r.adaptive, function (v) {
          save(Object.assign({}, saved(), { adaptive: v }));
          refreshSummary();
        });
        toggleRow('gfx-fps', t('showFps'), t('showFpsDesc'), r.showFps, function (v) {
          save(Object.assign({}, saved(), { show_fps: v }));
          refreshSummary();
        });

        summaryEl = el('p', 'gfx-summary');
        summaryEl.id = 'gfx-summary';
        summaryEl.setAttribute('aria-live', 'off');
        box.appendChild(summaryEl);
        noteEl = el('p', 'gfx-note');
        noteEl.id = 'gfx-note';
        box.appendChild(noteEl);
        refreshSummary();
        if (focusId) { var f = document.getElementById(focusId); if (f) f.focus(); }
      }

      render();
      // Keep pixels / fps / post status current while the panel is open.
      var timer = setInterval(function () {
        if (!box.isConnected) { clearInterval(timer); return; }
        refreshSummary();
      }, 1000);
    }

    // ------------------------------------------------------------ help

    function showHelp() {
      openScreen('help', function (body) {
        var cards = [
          { t: 'Objective', d: 'Move all 52 cards to the four foundations — one per suit, ace up to king.' },
          { t: 'Tableau', d: 'Eight columns build downward in alternating colors. Only ordered runs travel together.' },
          { t: 'Cells', d: 'Four temporary cells, one card each. They are your working room — empty them again soon.' },
          { t: 'Supermoves', d: 'Run length you may move = (free cells + 1) × 2^(empty columns). Free space is power.' },
          { t: 'Empty columns', d: 'Any card or run may take an empty column. They double your moving capacity.' },
          { t: 'Collect', d: 'Cards that can never be needed again may be swept home automatically with Collect (A).' },
          { t: 'Scoring', d: 'Completion first, then efficiency: fewer moves and a calm clock beat haste. Invalid attempts cost a little; undos cost a little.' }
        ];
        var grid = el('div', 'help-grid');
        cards.forEach(function (c) {
          var card = el('div', 'help-card');
          card.appendChild(el('h3', null, c.t));
          card.appendChild(el('p', null, c.d));
          grid.appendChild(card);
        });
        body.appendChild(grid);
        var k = actions.keyText;
        var kb = el('p', null, 'Controls — ' + [k('navLeft'), k('navRight'), k('navUp'), k('navDown')].join(' ') + ' navigate, Enter/Space select or place, ' +
          k('cancel') + ' cancels, ' + k('undo') + ' undo, ' + k('hint') + ' hint, ' + k('auto') + ' collect, ' + k('restart') +
          ' restart (with confirmation), ' + k('cameraReset') + ' camera reset.');
        body.appendChild(kb);
      }, { title: 'How to play', wide: true });
    }

    // ------------------------------------------------------------ boards & achievements

    function showBoards() {
      openScreen('boards', function (body) {
        var hostedSlot = el('div');
        body.appendChild(hostedSlot);
        if (P.apiAvailable()) {
          hostedSlot.appendChild(el('h3', null, 'StarHermit leaderboard'));
          var note = el('p', 'board-note', 'Loading…');
          hostedSlot.appendChild(note);
          P.getHostedLeaderboard().then(function (lb) {
            if (!lb) { note.textContent = 'Global leaderboard unavailable — local records below.'; return; }
            if (lb.me && (lb.me.rank != null || lb.me.score != null)) {
              note.textContent = 'Your best: '
                + (lb.me.score != null ? lb.me.score + (lb.me.rank != null ? ' · rank ' + lb.me.rank : '') : 'rank ' + lb.me.rank)
                + '.';
            }
            if (!lb.entries.length) {
              if (!lb.me) note.textContent = 'No global entries yet — local records below.';
              return;
            }
            hostedSlot.appendChild(hostedTable(lb.entries));
          });
        }
        var names = ['daily', 'journey', 'chase', 'challenge'];
        var labels = { daily: 'Daily board', journey: 'Journey board', chase: 'Score chase', challenge: 'Challenge board' };
        names.forEach(function (boardName) {
          body.appendChild(el('h3', null, labels[boardName]));
          body.appendChild(boardTable(P.getBoard(boardName)));
        });
        body.appendChild(el('h3', null, 'Practice (casual, unvalidated)'));
        body.appendChild(el('p', 'board-note', 'This board is local and unvalidated — casual only.'));
        body.appendChild(boardTable(P.getBoard('practice-local')));
        body.appendChild(el('h3', null, 'Achievements'));
        var save = P.loadSave().doc;
        var ul = el('ul', 'ach-list');
        C.ACHIEVEMENTS.forEach(function (a) {
          var unlocked = save.achievements[a.key];
          var li = el('li', unlocked ? 'ach unlocked' : 'ach');
          li.appendChild(el('strong', null, (unlocked ? '✓ ' : '') + a.title));
          li.appendChild(el('span', null, ' — ' + a.description));
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }, { title: 'Scores & achievements', wide: true });
    }

    function hostedTable(entries) {
      var table = el('table', 'board-table');
      var thead = el('thead');
      var hr = el('tr');
      ['#', 'Player', 'Score'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = el('tbody');
      entries.forEach(function (e, i) {
        var tr = el('tr');
        tr.appendChild(el('td', null, String(e.rank != null ? e.rank : i + 1)));
        tr.appendChild(el('td', null, e.name || 'Player'));
        tr.appendChild(el('td', null, String(e.score != null ? e.score : '')));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      return table;
    }

    function boardTable(entries) {
      if (!entries.length) return el('p', 'board-empty', 'No results yet.');
      var table = el('table', 'board-table');
      var thead = el('thead');
      var hr = el('tr');
      ['#', 'Score', 'Deal', 'Moves', 'Time'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = el('tbody');
      entries.slice(0, 10).forEach(function (e, i) {
        var tr = el('tr');
        tr.appendChild(el('td', null, String(i + 1)));
        tr.appendChild(el('td', null, String(e.score.total)));
        tr.appendChild(el('td', null, e.dealId));
        tr.appendChild(el('td', null, String(e.moves)));
        tr.appendChild(el('td', null, fmtTime(e.durationMs)));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      return table;
    }

    // ------------------------------------------------------------ results

    function showResults(data) {
      // data: { status, reason, score, moves, invalid, undos, elapsedMs, dealId,
      //         ranked, journeyStage, stars, achievements, lesson, onNextLabel }
      openScreen('results', function (body) {
        var headline = data.status === 'won' ? 'Deal cleared.' :
          data.reason === 'conceded' ? 'Deal conceded.' :
          data.reason === 'move-limit-exceeded' ? 'Out of moves.' :
          data.reason === 'time-limit-exceeded' ? 'Out of time.' : 'Deal over.';
        var h = el('p', 'results-headline', headline);
        body.appendChild(h);

        var table = el('table', 'score-table');
        var rows = [
          ['Cards home', data.score.completion],
          ['Win bonus', data.score.winBonus],
          ['Move efficiency', data.score.efficiency],
          ['Time bonus', data.score.timeBonus],
          ['Invalid attempts', data.score.invalidPenalty],
          ['Undos', data.score.undoPenalty]
        ];
        rows.forEach(function (r) {
          var tr = el('tr');
          tr.appendChild(el('td', null, r[0]));
          var td = el('td', 'score-num', (r[1] > 0 ? '+' : '') + r[1]);
          tr.appendChild(td);
          table.appendChild(tr);
        });
        var total = el('tr', 'score-total');
        total.appendChild(el('td', null, 'Total'));
        total.appendChild(el('td', 'score-num', String(data.score.total)));
        table.appendChild(total);
        body.appendChild(table);

        body.appendChild(el('p', 'results-meta',
          data.moves + ' moves · ' + fmtTime(data.elapsedMs) + ' · deal ' + data.dealId +
          (data.ranked ? ' · ranked' : ' · unranked')));

        if (data.stars) {
          body.appendChild(el('p', 'results-stars', '★'.repeat(data.stars) + '☆'.repeat(3 - data.stars)));
        }
        if (data.achievements && data.achievements.length) {
          var div = el('div', 'results-ach');
          div.appendChild(el('h3', null, 'Achievements unlocked'));
          data.achievements.forEach(function (a) {
            div.appendChild(el('p', null, '✓ ' + a.title + ' — ' + a.description));
          });
          body.appendChild(div);
        }

        var row = el('div', 'title-row');
        if (data.onNextLabel) row.appendChild(button(data.onNextLabel, 'btn btn-primary', function () { closeAll(); actions.onNext(); }));
        row.appendChild(button('Retry', 'btn', function () { closeAll(); actions.onRetry(); }));
        row.appendChild(button('Leave', 'btn btn-quiet', function () { closeAll(); actions.onLeave(); }));
        body.appendChild(row);

        announce(headline + ' Total score ' + data.score.total + '.', true);
      }, { title: 'Results', noEscape: false });
    }

    // ------------------------------------------------------------ HUD

    var hudEls = null;
    function bindHud(rootEl) {
      hudEls = {
        objective: rootEl.querySelector('#hud-objective'),
        progress: rootEl.querySelector('#hud-progress'),
        moves: rootEl.querySelector('#hud-moves'),
        time: rootEl.querySelector('#hud-time'),
        score: rootEl.querySelector('#hud-score'),
        deal: rootEl.querySelector('#hud-deal'),
        lesson: rootEl.querySelector('#hud-lesson'),
        leftRail: rootEl.querySelector('#rail-left'),
        undoCount: rootEl.querySelector('#hud-undo-count'),
        player: rootEl.querySelector('#hud-player'),
        sync: rootEl.querySelector('#hud-sync')
      };
    }

    function updateHud(d) {
      if (!hudEls) return;
      if (hudEls.objective) hudEls.objective.textContent = d.objective;
      if (hudEls.progress) hudEls.progress.textContent = d.progress;
      if (hudEls.moves) hudEls.moves.textContent = d.moves;
      if (hudEls.time) hudEls.time.textContent = d.time;
      if (hudEls.score) hudEls.score.textContent = d.score;
      if (hudEls.deal) hudEls.deal.textContent = d.deal;
      if (hudEls.undoCount) hudEls.undoCount.textContent = d.undoCount;
      if (hudEls.lesson) {
        hudEls.lesson.textContent = d.lessonText || '';
        hudEls.lesson.classList.toggle('hidden', !d.lessonText);
      }
    }

    // Player identity + cloud sync state, shown in the topbar when hosted.
    // Short-lived visible notice (also read by screen readers).
    var toastTimer = 0;
    function toast(text) {
      var t = document.getElementById('oc-toast');
      if (!t) {
        t = el('div', 'oc-toast');
        t.id = 'oc-toast';
        t.setAttribute('role', 'status');
        document.body.appendChild(t);
      }
      t.textContent = text;
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
    }

    function updatePlayer(st) {
      if (!hudEls) return;
      if (hudEls.player) {
        hudEls.player.textContent = '';
        if (st.avatar) {
          var img = el('img', 'player-avatar');
          img.src = st.avatar; img.alt = ''; img.width = 18; img.height = 18;
          hudEls.player.appendChild(img);
        }
        hudEls.player.appendChild(document.createTextNode(st.name || ''));
        hudEls.player.hidden = !st.name;
      }
      if (hudEls.sync) {
        var label = st.sync === 'saving' ? 'saving…'
          : st.sync === 'synced' ? 'cloud save ✓'
          : st.sync === 'error' ? 'sync failed'
          : '';
        hudEls.sync.textContent = label;
        hudEls.sync.dataset.state = st.sync || '';
        hudEls.sync.hidden = !label;
      }
    }

    // ------------------------------------------------------------ appearance

    function applySettings(s) {
      var root = document.documentElement;
      root.classList.toggle('larger-text', !!s.largerText);
      root.classList.toggle('high-contrast', !!s.highContrast);
      root.classList.toggle('reduced-motion', !!s.reducedMotion);
      root.classList.toggle('left-handed', !!s.leftHanded);
      root.dataset.palette = s.colorPalette;
      root.dataset.theme = s.theme;
    }

    return {
      announce: announce,
      openScreen: openScreen,
      closeTop: closeTop,
      closeAll: closeAll,
      hasOpenScreen: function () { return openStack.length > 0; },
      topScreenName: function () {
        var top = openStack[openStack.length - 1];
        return top ? top.dataset.screen : null;
      },
      showTitle: showTitle,
      showModes: showModes,
      showJourney: showJourney,
      showLearn: showLearn,
      showPracticeSetup: showPracticeSetup,
      showChallengeSetup: showChallengeSetup,
      showDailySetup: showDailySetup,
      showChaseSetup: showChaseSetup,
      showPause: showPause,
      showSettings: showSettings,
      showHelp: showHelp,
      showBoards: showBoards,
      showResults: showResults,
      bindHud: bindHud,
      updateHud: updateHud,
      updatePlayer: updatePlayer,
      toast: toast,
      applySettings: applySettings
    };
  }

  global.OCUi = { createUi: createUi, fmtTime: fmtTime };
})(typeof self !== 'undefined' ? self : this);
