/*
 * Open Cells — audio.
 * Authored one-shot samples (sfx/<name>.opus, see sfx/manifest.json) routed
 * through the effects bus, with original procedural transients as fallback
 * while a sample loads or if it is unavailable. Music, ambience, and voice
 * stay synthesized. Buses have independent gain; seeded pitch variants keep
 * replays consistent. All audio is decorative: no audio-only gameplay, and
 * every meaningful cue has a text equivalent in the UI.
 * Browser only. Exposes window.OCAudio.
 */
(function (global) {
  'use strict';

  var ctx = null;
  var buses = {};             // name -> GainNode
  var master = null;
  var started = false;
  var ambienceNodes = null;
  var musicNodes = null;
  var volumes = { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.7 };
  var muted = false;
  var sampleCache = {};       // basename -> { state: 'loading'|'ready'|'failed', buffer }

  function ensureContext() {
    if (ctx) return true;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    ['music', 'effects', 'ambience', 'voice'].forEach(function (name) {
      var g = ctx.createGain();
      g.gain.value = muted ? 0 : (volumes[name] != null ? volumes[name] : 0.5);
      g.connect(master);
      buses[name] = g;
    });
    return true;
  }

  // Browsers gate audio behind a user gesture; call from any input handler.
  function unlock() {
    if (!ensureContext()) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (!started) { started = true; startAmbience(); startMusic(); }
  }

  function setVolumes(v) {
    volumes = Object.assign({}, volumes, v);
    if (!ctx) return;
    Object.keys(buses).forEach(function (name) {
      if (volumes[name] != null) buses[name].gain.value = muted ? 0 : volumes[name];
    });
  }

  function setMuted(m) {
    muted = !!m;
    setVolumes({});
  }

  // Deterministic pitch variant from a seed (session-seeded for replays).
  function variant(seed) {
    var h = 0x811c9dc5 ^ (seed >>> 0);
    h = Math.imul(h ^ (h >>> 13), 0x01000193) >>> 0;
    return 0.94 + (h % 1000) / 1000 * 0.12; // ±6%
  }

  // ---------------------------------------------------------------- synths

  function blip(busName, opts) {
    if (!ctx || muted) return;
    var bus = buses[busName || 'effects'];
    var t = ctx.currentTime + (opts.delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq * (opts.pitch || 1), t);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t + (opts.dur || 0.1));
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(opts.gain || 0.2, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (opts.dur || 0.12));
    osc.connect(gain); gain.connect(bus);
    osc.start(t); osc.stop(t + (opts.dur || 0.12) + 0.05);
  }

  function noiseHit(busName, opts) {
    if (!ctx || muted) return;
    var bus = buses[busName || 'effects'];
    var t = ctx.currentTime + (opts.delay || 0);
    var len = Math.floor(ctx.sampleRate * (opts.dur || 0.08));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    var s = opts.seed || 1;
    for (var i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      data[i] = ((s / 4294967296) * 2 - 1) * (1 - i / len);
    }
    var src = ctx.createBufferSource(); src.buffer = buf;
    var filter = ctx.createBiquadFilter();
    filter.type = opts.filter || 'bandpass';
    filter.frequency.value = opts.freq || 1800;
    filter.Q.value = opts.q || 1.2;
    var gain = ctx.createGain();
    gain.gain.value = opts.gain || 0.25;
    src.connect(filter); filter.connect(gain); gain.connect(bus);
    src.start(t);
  }

  // Event map — input ack < legal move < goal < round completion.
  var EVENTS = {
    'select':   function (seed) { blip('effects', { freq: 660, type: 'triangle', dur: 0.05, gain: 0.08, pitch: variant(seed) }); },
    'deselect': function (seed) { blip('effects', { freq: 440, type: 'triangle', dur: 0.05, gain: 0.06, pitch: variant(seed) }); },
    'pickup':   function (seed) { noiseHit('effects', { freq: 2400, dur: 0.05, gain: 0.12, seed: seed }); },
    'drop':     function (seed) { noiseHit('effects', { freq: 900, dur: 0.09, gain: 0.22, seed: seed }); blip('effects', { freq: 180, type: 'sine', dur: 0.09, gain: 0.14, pitch: variant(seed) }); },
    'cell':     function (seed) { noiseHit('effects', { freq: 1400, dur: 0.07, gain: 0.16, seed: seed }); blip('effects', { freq: 520, type: 'sine', dur: 0.08, gain: 0.1, pitch: variant(seed) }); },
    'foundation': function (seed) { blip('effects', { freq: 720, type: 'triangle', dur: 0.14, gain: 0.16, pitch: variant(seed), slideTo: 1080 }); },
    'invalid':  function () { blip('effects', { freq: 160, type: 'square', dur: 0.1, gain: 0.07 }); },
    'undo':     function (seed) { blip('effects', { freq: 500, type: 'sine', dur: 0.08, gain: 0.1, slideTo: 320, pitch: variant(seed) }); },
    'hint':     function () { blip('effects', { freq: 880, type: 'sine', dur: 0.12, gain: 0.08 }); blip('effects', { freq: 1174, type: 'sine', dur: 0.12, gain: 0.06, delay: 0.08 }); },
    'lesson-step': function () { blip('effects', { freq: 784, type: 'triangle', dur: 0.1, gain: 0.12 }); blip('effects', { freq: 1046, type: 'triangle', dur: 0.14, gain: 0.1, delay: 0.07 }); },
    'win':      function () { [523, 659, 784, 1046, 1318].forEach(function (f, i) { blip('effects', { freq: f, type: 'triangle', dur: 0.3, gain: 0.14, delay: i * 0.11 }); }); },
    'lose':     function () { [392, 330, 262].forEach(function (f, i) { blip('effects', { freq: f, type: 'sine', dur: 0.3, gain: 0.1, delay: i * 0.14 }); }); },
    'achievement': function () { [880, 1108, 1318, 1760].forEach(function (f, i) { blip('effects', { freq: f, type: 'sine', dur: 0.22, gain: 0.1, delay: i * 0.07 }); }); },
    // Deal-out flourish: a short run of paper transients as the desk lays 52 cards.
    'deal':     function (seed) { for (var i = 0; i < 6; i++) noiseHit('effects', { freq: 1500 + i * 120, dur: 0.05, gain: 0.1, seed: (seed || 1) + i * 7, delay: i * 0.055 }); },
    // Star award on the results screen: one bright ascending brass ping per star.
    'star':     function (seed) { [1046, 1318, 1568].forEach(function (f, i) { blip('effects', { freq: f, type: 'triangle', dur: 0.18, gain: 0.11, delay: i * 0.12, pitch: variant(seed) }); }); }
  };

  function play(event, seed) {
    if (!ctx || muted) return;
    var fn = EVENTS[event];
    var sample = SAMPLE_BY_EVENT[event];
    if (sample) {
      var used = false;
      try { used = playSample(sample); } catch (e) { /* fall through to synth */ }
      if (used) return;
    }
    if (fn) { try { fn(seed || 1); } catch (e) { /* audio must never break play */ } }
  }

  // ---------------------------------------------------------------- samples
  // Authored one-shots (sfx/manifest.json) backing the events above. Samples
  // are fetched and decoded lazily on first use — which can only happen after
  // unlock() has created the context via a user gesture — then cached. While
  // a sample is loading or if it fails, the event falls back to its synth.

  var SAMPLE_BY_EVENT = {
    'select': 'card-select',
    'deselect': 'card-deselect',
    'pickup': 'card-pickup',
    'drop': 'card-drop',
    'cell': 'cell-store',
    'foundation': 'foundation-build',
    'invalid': 'move-invalid',
    'undo': 'move-undo',
    'hint': 'hint-chime',
    'lesson-step': 'lesson-step',
    'win': 'deal-win',
    'lose': 'deal-lose',
    'achievement': 'achievement-unlock',
    'deal': 'deal-start',
    'star': 'star-award'
  };

  function loadSample(name) {
    var entry = sampleCache[name];
    if (entry) return entry;
    entry = sampleCache[name] = { state: 'loading', buffer: null };
    if (!global.fetch) { entry.state = 'failed'; return entry; }
    fetch('sfx/' + name + '.opus')
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (bytes) { return ctx.decodeAudioData(bytes); })
      .then(function (buffer) { entry.buffer = buffer; entry.state = 'ready'; })
      .catch(function () { entry.state = 'failed'; });
    return entry;
  }

  function playSample(name) {
    var entry = loadSample(name);
    if (entry.state !== 'ready') return false;
    var src = ctx.createBufferSource();
    src.buffer = entry.buffer;
    src.connect(buses.effects);
    src.start();
    return true;
  }

  // Quiet desk ambience: filtered brown-ish noise + faint clock tick.
  function startAmbience() {
    if (ambienceNodes || !ctx) return;
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    var last = 0, s = 7;
    for (var i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      var white = (s / 4294967296) * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 2.4;
    }
    var src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    var filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 320;
    src.connect(filter); filter.connect(buses.ambience);
    src.start();
    ambienceNodes = { src: src };
  }

  // Adaptive music: a slow two-chord pad; intensity rises near victory via
  // setMusicIntensity(0..1) which opens the filter and adds a third voice.
  function startMusic() {
    if (musicNodes || !ctx) return;
    var filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 500; filter.Q.value = 0.6;
    filter.connect(buses.music);
    var chords = [[220, 277.2, 329.6], [196, 246.9, 293.7]]; // A major-ish / E major-ish, original voicing
    var oscs = [];
    chords[0].concat([0]).forEach(function () {});
    var voices = [];
    for (var v = 0; v < 4; v++) {
      var o = ctx.createOscillator(); o.type = 'sine';
      var g = ctx.createGain(); g.gain.value = v < 3 ? 0.05 : 0;
      o.connect(g); g.connect(filter); o.start();
      voices.push({ osc: o, gain: g });
      oscs.push(o);
    }
    var step = 0;
    var timer = setInterval(function () {
      if (!ctx) { clearInterval(timer); return; }
      var chord = chords[step % 2];
      var t = ctx.currentTime;
      for (var i = 0; i < 3; i++) voices[i].osc.frequency.linearRampToValueAtTime(chord[i], t + 1.6);
      step++;
    }, 4000);
    musicNodes = { filter: filter, voices: voices, timer: timer };
  }

  function setMusicIntensity(x) {
    if (!musicNodes || !ctx) return;
    var t = ctx.currentTime;
    musicNodes.filter.frequency.linearRampToValueAtTime(500 + x * 1800, t + 1.0);
    musicNodes.voices[3].gain.gain.linearRampToValueAtTime(x * 0.05, t + 1.0);
    if (x > 0.5) musicNodes.voices[3].osc.frequency.setValueAtTime(440 * (x > 0.8 ? 1.5 : 1.25), t);
  }

  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }
  function resume() { if (ctx && ctx.state === 'suspended' && started) ctx.resume(); }

  global.OCAudio = {
    unlock: unlock,
    play: play,
    setVolumes: setVolumes,
    setMuted: setMuted,
    setMusicIntensity: setMusicIntensity,
    suspend: suspend,
    resume: resume,
    isAvailable: function () { return !!(global.AudioContext || global.webkitAudioContext); }
  };
})(typeof self !== 'undefined' ? self : this);
