/*
 * Open Cells — render layer (Three.js).
 * Brass-and-slate strategy desk: authored camera, procedural geometry and
 * canvas-texture card faces, PBR lighting with one dominant key plus
 * image-based light, pooled particles, Graphics settings (OCGfx presets and
 * overrides, post-processing chain, adaptive resolution), explicit disposal,
 * WebGL context recovery.
 * Rendering consumes immutable snapshots; it never mutates rules state.
 * Browser only. Exposes window.OCRender.
 */
(function (global) {
  'use strict';

  var THREE = global.THREE;

  // ---------------------------------------------------------------- layout model
  // Single shared layout model (spec §3): all positions derive from these
  // constants, and the DOM accessibility layer uses the same logical order.
  var LAYOUT = {
    cardW: 0.92, cardH: 1.3, cardD: 0.024,
    gapX: 0.16,
    topRowZ: -3.1,          // cells & foundations
    colTopZ: -1.35,         // first card of each column
    stackDY: 0.36,          // visible overlap between stacked cards
    stackRise: 0.006,       // per-card height rise to avoid z-fighting
    liftY: 0.22             // selection lift
  };

  var CAMERA = { fov: 30, dist: 10.4, height: 8.2, back: 4.6, lookZ: 0.45 };

  function columnX(i) { return (i - 3.5) * (LAYOUT.cardW + LAYOUT.gapX); }
  function slotX(i, right) {
    var step = LAYOUT.cardW + LAYOUT.gapX;
    return right ? (3.5 * step - i * step) : (-3.5 * step + i * step);
  }

  // World position for a logical location + stack depth.
  function locToWorld(loc, depth) {
    depth = depth || 0;
    if (loc.zone === 'cell') return { x: slotX(loc.index, false), y: 0.02, z: LAYOUT.topRowZ };
    if (loc.zone === 'foundation') return { x: slotX(loc.index, true), y: 0.02, z: LAYOUT.topRowZ };
    return {
      x: columnX(loc.index),
      y: 0.02 + depth * LAYOUT.stackRise,
      z: LAYOUT.colTopZ + depth * LAYOUT.stackDY
    };
  }

  // ---------------------------------------------------------------- card face textures

  var textureCache = new Map();

  // Card faces are drawn on a 128x184 design grid; `hi` (Surface detail:
  // Detailed) renders the same layout at 2x with a linen weave and a gilt
  // inner rule, so glyph positions and sizes are identical in both tiers.
  function cardTexture(cardId, theme, hi) {
    var k = hi ? 2 : 1;
    var key = theme.id + '/' + cardId + '/' + k;
    if (textureCache.has(key)) return textureCache.get(key);
    var W = 128, H = 184;
    var cv = document.createElement('canvas');
    cv.width = W * k; cv.height = H * k;
    var g = cv.getContext('2d');
    g.scale(k, k);
    var R = global.OCRules;
    var suit = R.suitOf(cardId), rank = R.rankOf(cardId);
    var red = R.colorOf(cardId) === 'red';
    var ink = red ? theme.suitRed : theme.suitBlack;

    // Face with subtle mottling (procedural, deterministic per card).
    g.fillStyle = theme.cardFace;
    g.fillRect(0, 0, W, H);
    var s = (cardId + 1) * 2654435761 >>> 0;
    for (var i = 0; i < 60; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      g.fillStyle = 'rgba(0,0,0,0.018)';
      g.fillRect(s % W, (s >>> 8) % H, 3, 3);
    }
    if (hi) {
      // Linen weave: faint crossing hairlines, well below text contrast.
      g.lineWidth = 0.5;
      g.strokeStyle = 'rgba(90,70,40,0.045)';
      for (var y = 0.5; y < H; y += 1.5) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      g.strokeStyle = 'rgba(90,70,40,0.035)';
      for (var x = 0.5; x < W; x += 1.5) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      // Soft paper edge falloff.
      var edge = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.62);
      edge.addColorStop(0, 'rgba(255,250,235,0)');
      edge.addColorStop(1, 'rgba(120,95,50,0.07)');
      g.fillStyle = edge; g.fillRect(0, 0, W, H);
      // Gilt inner rule, kept clear of the rank strip.
      g.strokeStyle = theme.deskTrim; g.globalAlpha = 0.55; g.lineWidth = 0.8;
      g.strokeRect(5.5, 42.5, W - 11, H - 85);
      g.globalAlpha = 1;
    }
    // Corner indices (top-left + bottom-right, rotated).
    g.fillStyle = ink;
    // Rank strip: large index + suit side by side so the exposed strip of a
    // stacked card stays legible even at phone sizes.
    g.font = 'bold 36px Georgia, serif';
    g.textAlign = 'left'; g.textBaseline = 'top';
    var label = R.RANK_LABELS[rank - 1];
    var sym = R.SUIT_SYMBOLS[suit];
    g.fillText(label, 8, 4);
    g.font = '30px Georgia, serif';
    g.fillText(sym, label.length > 1 ? 52 : 36, 6);
    g.save();
    g.translate(W, H); g.rotate(Math.PI);
    g.font = 'bold 36px Georgia, serif';
    g.fillText(label, 8, 4);
    g.font = '30px Georgia, serif';
    g.fillText(sym, label.length > 1 ? 52 : 36, 6);
    g.restore();
    g.textAlign = 'center';
    // Center: big suit glyph; court cards get a simple geometric sigil so no
    // two ranks rely on color alone (shape-reinforced, spec §3).
    g.font = '54px Georgia, serif';
    g.textBaseline = 'middle';
    g.fillText(sym, W / 2, H / 2 - 6);
    if (rank >= 11) {
      g.strokeStyle = ink; g.lineWidth = 2;
      g.strokeRect(W / 2 - 24, H / 2 + 18, 48, 10);
    } else if (rank === 1) {
      g.beginPath(); g.arc(W / 2, H / 2 + 26, 8, 0, Math.PI * 2); g.strokeStyle = ink; g.lineWidth = 2; g.stroke();
    }
    // Thin frame.
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
    g.strokeRect(1, 1, W - 2, H - 2);

    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = hi ? 8 : 4;
    textureCache.set(key, tex);
    return tex;
  }

  function backTexture(theme) {
    var key = theme.id + '/back';
    if (textureCache.has(key)) return textureCache.get(key);
    var W = 128, H = 184;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    g.fillStyle = theme.cardBack;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 1;
    for (var i = -H; i < W; i += 10) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + H, H); g.stroke();
      g.beginPath(); g.moveTo(i + H, 0); g.lineTo(i, H); g.stroke();
    }
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 3;
    g.strokeRect(2, 2, W - 4, H - 4);
    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    textureCache.set(key, tex);
    return tex;
  }

  // Grayscale procedural surface textures (Surface detail: Detailed). Values
  // sit just under white so the material colour (the theme) still rules.
  function surfaceTexture(kind, size) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var g = cv.getContext('2d');
    var img = g.createImageData(size, size);
    var d = img.data;
    var seed = kind === 'slate' ? 7 : kind === 'felt' ? 13 : 29;
    function hash(x, y) {
      var h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
      h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
      return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    }
    // Tileable value noise.
    function vnoise(x, y, period) {
      var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      function c(a, b) { return hash(((a % period) + period) % period, ((b % period) + period) % period); }
      return (c(xi, yi) * (1 - u) + c(xi + 1, yi) * u) * (1 - v) + (c(xi, yi + 1) * (1 - u) + c(xi + 1, yi + 1) * u) * v;
    }
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var v;
        if (kind === 'slate') {
          var n = vnoise(x / 64, y / 64, size / 64) * 0.5 + vnoise(x / 16, y / 16, size / 16) * 0.3 + vnoise(x / 4, y / 4, size / 4) * 0.2;
          v = 0.86 + n * 0.14 + (hash(x, y) - 0.5) * 0.02;
        } else if (kind === 'felt') {
          var f = vnoise(x / 2, y / 2, size / 2) * 0.7 + hash(x, y) * 0.3;
          v = 0.9 + f * 0.08 + (vnoise(x / 32, y / 32, size / 32) - 0.5) * 0.05;
        } else { // wood: stretched grain rings along x
          var grain = vnoise(x / 180, y / 5, Math.max(1, size / 180)) * 6 + vnoise(x / 40, y / 40, size / 40) * 1.5;
          var ring = 0.5 + 0.5 * Math.sin(grain * Math.PI * 2);
          v = 0.7 + ring * 0.22 + (hash(x, y) - 0.5) * 0.04;
        }
        var b = Math.max(0, Math.min(255, Math.round(v * 255)));
        var o = (y * size + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = b; d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  // Soft round sprite for particles and motes.
  var spriteTex = null;
  function spriteTexture() {
    if (spriteTex) return spriteTex;
    var cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    var g = cv.getContext('2d');
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    spriteTex = new THREE.CanvasTexture(cv);
    return spriteTex;
  }

  function disposeTextures() {
    textureCache.forEach(function (t) { t.dispose(); });
    textureCache.clear();
  }

  // ---------------------------------------------------------------- tweens
  // Authored duration/easing, interruptible, reduced-motion aware. Never
  // cumulative per-frame lerp: every tween stores explicit from/to.

  function makeTweener() {
    var active = [];
    function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
    return {
      add: function (obj) {
        // obj: { duration, update(k), done?() , tag }
        obj.elapsed = 0;
        active.push(obj);
        return obj;
      },
      cancelByTag: function (tag) {
        active = active.filter(function (t) {
          if (t.tag === tag) { if (t.done) t.done(true); return false; }
          return true;
        });
      },
      settle: function () {
        var list = active; active = [];
        list.forEach(function (t) { t.update(1); if (t.done) t.done(false); });
      },
      update: function (dt) {
        var keep = [];
        for (var i = 0; i < active.length; i++) {
          var t = active[i];
          t.elapsed += dt;
          var k = Math.min(1, t.elapsed / t.duration);
          t.update(easeInOut(k));
          if (k >= 1) { if (t.done) t.done(false); } else keep.push(t);
        }
        active = keep;
      },
      count: function () { return active.length; }
    };
  }

  // ---------------------------------------------------------------- renderer

  // Post chain addons (same three.js revision, r152), loaded on demand via
  // the page's import map. Null until loaded; rejected -> post unavailable.
  var addonsPromise = null;
  function loadAddons() {
    if (!addonsPromise) {
      var base = 'three/addons/';
      addonsPromise = Promise.all([
        import(base + 'postprocessing/EffectComposer.js'),
        import(base + 'postprocessing/RenderPass.js'),
        import(base + 'postprocessing/ShaderPass.js'),
        import(base + 'postprocessing/UnrealBloomPass.js'),
        import(base + 'postprocessing/SMAAPass.js'),
        import(base + 'shaders/FXAAShader.js'),
        import(base + 'environments/RoomEnvironment.js')
      ]).then(function (m) {
        return {
          EffectComposer: m[0].EffectComposer, RenderPass: m[1].RenderPass, ShaderPass: m[2].ShaderPass,
          UnrealBloomPass: m[3].UnrealBloomPass, SMAAPass: m[4].SMAAPass, FXAAShader: m[5].FXAAShader,
          RoomEnvironment: m[6].RoomEnvironment
        };
      });
    }
    return addonsPromise;
  }

  // Colour grade + vignette + linear->sRGB output (the composer's output
  // stage; with grade off it only encodes). Gentle S-curve, a touch more
  // saturation, warm highlights and cool shadows; blacks lifted slightly so
  // dark suits never crush.
  var GradeShader = {
    uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.24 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;',
      'varying vec2 vUv;',
      'vec3 ocToSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }',
      'void main() {',
      '  vec4 src = texture2D(tDiffuse, vUv);',
      '  vec3 c = src.rgb;',
      '  vec3 lc = clamp(c, 0.0, 1.0);',
      '  vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.18);',
      '  float l = dot(s, vec3(0.2126, 0.7152, 0.0722));',
      '  s = mix(vec3(l), s, 1.07);',
      '  s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.96), smoothstep(0.05, 0.6, l));',
      '  s = s * 0.985 + 0.004;',
      '  c = mix(c, s + max(c - 1.0, 0.0), uAmount);',
      '  float d = length((vUv - 0.5) * vec2(1.0, 0.85));',
      '  c *= 1.0 - uVignette * smoothstep(0.3, 0.8, d);',
      '  gl_FragColor = vec4(ocToSRGB(c), 1.0);',
      '}'
    ].join('\n')
  };

  /** Unmasked GPU name for Auto detection (no console noise in any browser). */
  function gpuName(gl) {
    try {
      if (/firefox/i.test(navigator.userAgent)) return String(gl.getParameter(gl.RENDERER) || '');
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '';
    } catch (e) { return ''; }
  }

  function isTouchDevice() {
    try { return !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; }
  }

  function createRenderer(canvas, options) {
    options = options || {};
    var theme = options.theme;
    var reducedMotion = !!options.reducedMotion;
    var G = global.OCGfx;

    // The canvas never uses native MSAA: anti-aliasing is a Graphics
    // category, applied through the composer (MSAA = multisampled target),
    // so every tier switches live and Low stays as cheap as it was.
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    var gpu = gpuName(renderer.getContext());
    var touch = isTouchDevice();
    var detected = G.detectPreset(gpu, touch);
    var savedGfx = options.graphics || {};
    var gfxJson = null;
    var q = G.resolve(savedGfx, detected);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 100);

    var tweener = makeTweener();
    var cardMeshes = new Map();   // cardId -> { mesh, loc, depth }
    var slotMeshes = [];          // { mesh, loc, kind }
    var markerMeshes = { selection: null, targets: [], hint: null };
    var state = null;
    var pointerCb = null;
    var destroyed = false;
    var clock = { last: 0 };

    // ---- lighting: one dominant warm key (the desk lamp), hemisphere fill,
    // a cool rim, and image-based light from a PMREM room environment.
    var hemi = new THREE.HemisphereLight(0xfff2dd, 0x20262e, 0.55);
    scene.add(hemi);
    var key = new THREE.DirectionalLight(0xffe8c0, 1.35);
    key.position.set(4, 9, 3);
    key.target.position.set(0, 0, 0.1);
    scene.add(key.target);
    // Shadow frustum fitted to the desk slab (11.4 x 9.6) as seen from the key.
    key.shadow.camera.left = -6.6; key.shadow.camera.right = 6.6;
    key.shadow.camera.top = 5.6; key.shadow.camera.bottom = -5.6;
    key.shadow.camera.near = 4; key.shadow.camera.far = 18;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.01;
    key.shadow.radius = 3;
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xb0c4de, 0.25);
    fill.position.set(-5, 6, -2);
    scene.add(fill);

    // Image-based lighting (Reflections: On). Built once, lazily.
    var envRT = null;
    function ensureEnvironment() {
      if (envRT || destroyed) return;
      loadAddons().then(function (A) {
        if (envRT || destroyed) return;
        var pmrem = new THREE.PMREMGenerator(renderer);
        var room = new A.RoomEnvironment();
        envRT = pmrem.fromScene(room, 0.04);
        room.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        pmrem.dispose();
        applyEnvironment();
      }, function () { /* no addons: plain lighting */ });
    }
    function applyEnvironment() {
      var on = q.reflections === 'on' && envRT;
      scene.environment = on ? envRT.texture : null;
      hemi.intensity = on ? 0.32 : 0.55;
      fill.intensity = on ? 0.18 : 0.25;
    }

    // ---- environment group (disposed wholesale on teardown)
    var envGroup = new THREE.Group();
    scene.add(envGroup);

    function envMat(color, rough, metal, envI, texKind, repeat) {
      var m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: rough, metalness: metal });
      m.envMapIntensity = envI;
      if (texKind && q.detail === 'detailed') {
        var t = surfaceTexture(texKind, texKind === 'wood' ? 512 : 256);
        t.repeat.set(repeat[0], repeat[1]);
        m.map = t;
        if (texKind !== 'wood') { m.bumpMap = t; m.bumpScale = texKind === 'felt' ? 0.05 : 0.03; }
      }
      return m;
    }

    function buildEnvironment() {
      // Room: dark background with fog so the walnut surround fades out
      // instead of ending at a hard edge (no black bands at any aspect).
      var bg = new THREE.Color(theme.desk).multiplyScalar(0.28);
      scene.background = bg;
      scene.fog = new THREE.Fog(bg, 16, 34);
      if (size && size[0]) fitCamera(size[0] / Math.max(1, size[1]));

      // Walnut desktop around the slate slab, lit by a baked lamp pool.
      var woodCol = new THREE.Color(theme.desk).lerp(new THREE.Color(0x3a2a1c), 0.65);
      var surroundMat = envMat(woodCol, 0.62, 0.0, 0.25, 'wood', [12, 12]);
      // Lamp pool as vertex colours: full light near the slab, falling to
      // near-dark at the edges.
      surroundMat.vertexColors = true;
      var surroundGeom = new THREE.PlaneGeometry(120, 100, 60, 50);
      surroundGeom.rotateX(-Math.PI / 2);
      var sp = surroundGeom.attributes.position;
      var cols = new Float32Array(sp.count * 3);
      for (var vi = 0; vi < sp.count; vi++) {
        var dx = sp.getX(vi) / 9.5, dz = (sp.getZ(vi) + 0.5) / 8;
        var r = Math.sqrt(dx * dx + dz * dz);
        var f = 0.12 + 0.88 * Math.pow(Math.max(0, 1 - r / 1.6), 1.6);
        cols[vi * 3] = f; cols[vi * 3 + 1] = f * 0.97; cols[vi * 3 + 2] = f * 0.92;
      }
      surroundGeom.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      var surround = new THREE.Mesh(surroundGeom, surroundMat);
      surround.position.set(0, -0.33, 1);
      surround.receiveShadow = true;
      envGroup.add(surround);

      // Slate desk slab.
      var deskMat = envMat(theme.desk, 0.85, 0.05, 0.35, 'slate', [3, 2.5]);
      var desk = new THREE.Mesh(new THREE.BoxGeometry(11.4, 0.3, 9.6), deskMat);
      desk.position.y = -0.16;
      desk.receiveShadow = true;
      desk.castShadow = true;
      envGroup.add(desk);

      // Brass trim strips framing the play area.
      var trimMat = envMat(theme.deskTrim, 0.3, 0.9, 1.1);
      var trimGeomH = new THREE.BoxGeometry(10.6, 0.045, 0.09);
      var trimGeomV = new THREE.BoxGeometry(0.09, 0.045, 8.4);
      [[0, -4.05, trimGeomH], [0, 3.75, trimGeomH], [-5.25, -0.15, trimGeomV], [5.25, -0.15, trimGeomV]].forEach(function (t) {
        var m = new THREE.Mesh(t[2], trimMat);
        m.position.set(t[0], 0.012, t[1]);
        m.castShadow = true;
        envGroup.add(m);
      });

      // Cloth inlay under the columns.
      var clothMat = envMat(theme.cloth, 0.95, 0, 0.12, 'felt', [3, 2]);
      var cloth = new THREE.Mesh(new THREE.BoxGeometry(9.9, 0.02, 6.2), clothMat);
      cloth.position.set(0, 0.002, 0.6);
      cloth.receiveShadow = true;
      envGroup.add(cloth);

      // Slot recesses: 4 cells + 4 foundations + 8 column guides.
      var slotMat = envMat(theme.slot, 0.9, 0.1, 0.3);
      var slotFrameMat = envMat(theme.deskTrim, 0.38, 0.85, 1.0);
      var slotGeom = new THREE.BoxGeometry(LAYOUT.cardW + 0.1, 0.014, LAYOUT.cardH + 0.1);
      var frameGeom = new THREE.BoxGeometry(LAYOUT.cardW + 0.18, 0.01, LAYOUT.cardH + 0.18);
      function addSlot(x, z, loc, kind) {
        var frame = new THREE.Mesh(frameGeom, slotFrameMat);
        frame.position.set(x, 0.004, z);
        var inner = new THREE.Mesh(slotGeom, slotMat.clone());
        inner.position.set(x, 0.012, z);
        inner.receiveShadow = true;
        inner.userData.loc = loc;
        inner.userData.kind = kind;
        envGroup.add(frame); envGroup.add(inner);
        slotMeshes.push({ mesh: inner, loc: loc, kind: kind });
      }
      for (var i = 0; i < 4; i++) {
        addSlot(slotX(i, false), LAYOUT.topRowZ, { zone: 'cell', index: i }, 'cell');
        addSlot(slotX(i, true), LAYOUT.topRowZ, { zone: 'foundation', index: i }, 'foundation');
      }
      for (var c = 0; c < 8; c++) {
        var guide = new THREE.Mesh(slotGeom, slotMat);
        guide.position.set(columnX(c), 0.008, LAYOUT.colTopZ);
        guide.receiveShadow = true;
        guide.material = slotMat;
        guide.userData.loc = { zone: 'tableau', index: c };
        guide.userData.kind = 'tableau';
        envGroup.add(guide);
        slotMeshes.push({ mesh: guide, loc: guide.userData.loc, kind: 'tableau' });
      }

      // Foundation suit engravings (small glyph plates above each slot).
      // Procedural and text-free in 3D; DOM labels carry the accessible names.
    }

    // ---- cards
    var cardShape = null;
    function roundedRectShape(w, h, r) {
      var s = new THREE.Shape();
      var x = -w / 2, y = -h / 2;
      s.moveTo(x + r, y);
      s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
      s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
      s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
      return s;
    }

    function cardGeometry() {
      if (!cardShape) cardShape = roundedRectShape(LAYOUT.cardW, LAYOUT.cardH, 0.07);
      var geom = new THREE.ExtrudeGeometry(cardShape, { depth: LAYOUT.cardD, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1 });
      // ExtrudeGeometry emits UVs in world units; normalize the caps to 0..1
      // so the face texture maps exactly once across the card.
      var pos = geom.attributes.position, uv = geom.attributes.uv;
      for (var i = 0; i < uv.count; i++) {
        var u = (pos.getX(i) + LAYOUT.cardW / 2) / LAYOUT.cardW;
        var v = (pos.getY(i) + LAYOUT.cardH / 2) / LAYOUT.cardH;
        uv.setXY(i, Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
      }
      geom.rotateX(-Math.PI / 2);
      return geom;
    }
    var sharedCardGeom = cardGeometry();

    // Card face: with Reflections on, a lightly clearcoated physical
    // material (a soft sheen from the room environment, kept low so faces
    // never wash out); otherwise the plain standard material.
    function makeFaceMat(cardId) {
      var face = cardTexture(cardId, theme, q.detail === 'detailed');
      if (q.reflections === 'on') {
        var pm = new THREE.MeshPhysicalMaterial({ map: face, roughness: 0.52, metalness: 0.0, clearcoat: 0.3, clearcoatRoughness: 0.42 });
        pm.envMapIntensity = 0.35;
        return pm;
      }
      return new THREE.MeshStandardMaterial({ map: face, roughness: 0.55, metalness: 0.02 });
    }

    function makeCardMesh(cardId) {
      var back = backTexture(theme);
      var sideMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c2, roughness: 0.6, metalness: 0 });
      sideMat.envMapIntensity = 0.3;
      var faceMat = makeFaceMat(cardId);
      var backMat = new THREE.MeshStandardMaterial({ map: back, roughness: 0.6, metalness: 0.05 });
      // ExtrudeGeometry groups: 0 = front/back caps... use multi-material:
      // [cap(front), side]. We assign face to cap; back is hidden (face-up game),
      // but keep a distinct back material for deal animations.
      var mesh = new THREE.Mesh(sharedCardGeom, [faceMat, sideMat]);
      mesh.castShadow = q.shadows !== 'off';
      mesh.receiveShadow = true;
      mesh.userData.cardId = cardId;
      mesh.userData.faceMat = faceMat;
      mesh.userData.sideMat = sideMat;
      mesh.userData.backMat = backMat;
      return mesh;
    }

    // ---- selection marker + target highlight + hint arrow
    var ringGeom = new THREE.RingGeometry(0.52, 0.62, 40);
    ringGeom.rotateX(-Math.PI / 2);

    // With bloom on, markers render above 1.0 (untone-mapped) so only they
    // and particles glow; the base colour is the theme accent either way.
    function tuneMarker(mat) {
      var glow = q.bloom === 'on' && composer;
      mat.color.set(theme.accent);
      if (glow) mat.color.multiplyScalar(1.7);
      mat.toneMapped = !glow;
      mat.needsUpdate = true;
    }
    function allMarkers() {
      return (markerMeshes.selection ? [markerMeshes.selection] : []).concat(targetMarkers);
    }

    function ensureMarkers() {
      if (!markerMeshes.selection) {
        var mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent), transparent: true, opacity: 0.85, side: THREE.DoubleSide });
        tuneMarker(mat);
        markerMeshes.selection = new THREE.Mesh(ringGeom, mat);
        markerMeshes.selection.visible = false;
        markerMeshes.selection.renderOrder = 5;
        scene.add(markerMeshes.selection);
      }
    }

    var targetMarkers = [];
    function setLegalTargets(locs) {
      ensureMarkers();
      // Pooled markers — reuse meshes across calls.
      while (targetMarkers.length < locs.length) {
        var mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent), transparent: true, opacity: 0.4, side: THREE.DoubleSide });
        tuneMarker(mat);
        var m = new THREE.Mesh(ringGeom, mat);
        m.renderOrder = 4;
        scene.add(m);
        targetMarkers.push(m);
      }
      targetMarkers.forEach(function (m, i) {
        if (i < locs.length) {
          var p = locToWorld(locs[i], locs[i].zone === 'tableau' ? (state ? state.tableau[locs[i].index].length : 0) : 0);
          m.position.set(p.x, 0.03, p.z);
          m.visible = true;
        } else m.visible = false;
      });
    }

    function setSelectionMarker(loc) {
      ensureMarkers();
      if (!loc) { markerMeshes.selection.visible = false; return; }
      var depth = 0;
      if (loc.zone === 'tableau' && state) depth = Math.max(0, state.tableau[loc.index].length - 1);
      var p = locToWorld(loc, depth);
      markerMeshes.selection.position.set(p.x, 0.035, p.z);
      markerMeshes.selection.visible = true;
    }

    // ---- particles: bounded pool, cosmetic only, never raycast targets.
    // Particles: Off (none), Low (half count, plain points), High (full
    // count, soft additive sprites that bloom).
    var particlePool = null;
    function particleLook() {
      var p = particlePool;
      if (!p) return;
      var hi = q.particles === 'high';
      var m = p.points.material;
      m.map = hi ? spriteTexture() : null;
      m.blending = hi ? THREE.AdditiveBlending : THREE.NormalBlending;
      m.size = hi ? 0.13 : 0.06;
      m.color.set(theme.accent);
      if (hi && q.bloom === 'on' && composer) m.color.multiplyScalar(1.8);
      m.toneMapped = !(hi && q.bloom === 'on' && composer);
      m.needsUpdate = true;
    }
    function ensureParticles() {
      if (particlePool) return;
      var MAX = 400; // well under the 5k mobile budget
      var geom = new THREE.BufferGeometry();
      var pos = new Float32Array(MAX * 3);
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      var mat = new THREE.PointsMaterial({ color: new THREE.Color(theme.accent), size: 0.06, transparent: true, opacity: 0.9, depthWrite: false });
      var points = new THREE.Points(geom, mat);
      points.visible = false;
      points.frustumCulled = false;
      points.raycast = function () {}; // cosmetic particles never intercept raycasts
      scene.add(points);
      particlePool = { points: points, pos: pos, vel: new Float32Array(MAX * 3), life: new Float32Array(MAX), active: false, max: MAX };
      particleLook();
    }

    function burst(x, y, z, count) {
      if (reducedMotion || q.particles === 'off') return;
      ensureParticles();
      var p = particlePool;
      if (q.particles === 'low') count = Math.ceil(count / 2);
      // Append after live particles so overlapping bursts do not cut each other.
      var start = 0;
      while (start < p.max && p.life[start] > 0) start++;
      var n = Math.min(count, p.max - start);
      for (var j = 0; j < n; j++) {
        var i = start + j;
        p.pos[i * 3] = x; p.pos[i * 3 + 1] = y; p.pos[i * 3 + 2] = z;
        var a = (j / n) * Math.PI * 2;
        var r = 0.8 + ((j * 7919) % 100) / 250;
        p.vel[i * 3] = Math.cos(a) * r;
        p.vel[i * 3 + 1] = 1.6 + ((j * 104729) % 100) / 120;
        p.vel[i * 3 + 2] = Math.sin(a) * r;
        p.life[i] = 1;
      }
      p.points.geometry.attributes.position.needsUpdate = true;
      p.points.visible = true;
      p.active = true;
    }

    function updateParticles(dt) {
      var p = particlePool;
      if (!p || !p.active) return;
      var any = false;
      for (var i = 0; i < p.max; i++) {
        if (p.life[i] <= 0) { p.pos[i * 3 + 1] = -50; continue; }
        any = true;
        p.life[i] -= dt * 1.4;
        p.vel[i * 3 + 1] -= dt * 3.2;
        p.pos[i * 3] += p.vel[i * 3] * dt;
        p.pos[i * 3 + 1] = Math.max(0.02, p.pos[i * 3 + 1] + p.vel[i * 3 + 1] * dt);
        p.pos[i * 3 + 2] += p.vel[i * 3 + 2] * dt;
        if (p.life[i] <= 0) p.pos[i * 3 + 1] = -50;
      }
      p.points.geometry.attributes.position.needsUpdate = true;
      if (!any) { p.active = false; p.points.visible = false; }
    }

    // ---- ambient motion (Ambient motion: On): dust motes drifting slowly
    // through the lamp light. Hidden under reduced motion.
    var motes = null;
    function ensureMotes() {
      if (motes) return;
      var N = 70;
      var pos = new Float32Array(N * 3), seed = new Float32Array(N);
      for (var i = 0; i < N; i++) {
        var h = Math.sin(i * 12.9898) * 43758.5453; h -= Math.floor(h);
        var h2 = Math.sin(i * 78.233) * 12543.123; h2 -= Math.floor(h2);
        var h3 = Math.sin(i * 39.425) * 24634.634; h3 -= Math.floor(h3);
        pos[i * 3] = (h - 0.5) * 11; pos[i * 3 + 1] = 0.6 + h2 * 3.4; pos[i * 3 + 2] = (h3 - 0.5) * 9;
        seed[i] = h * 100;
      }
      var geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      var mat = new THREE.PointsMaterial({ color: 0xffe2b0, size: 0.05, map: spriteTexture(), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
      var pts = new THREE.Points(geom, mat);
      pts.frustumCulled = false;
      pts.raycast = function () {};
      scene.add(pts);
      motes = { points: pts, pos: pos, seed: seed, n: N, t: 0 };
    }
    function updateMotes(dt) {
      var on = q.ambient === 'on' && !reducedMotion;
      if (on) ensureMotes();
      if (!motes) return;
      motes.points.visible = on;
      if (!on) { key.intensity = 1.35; return; }
      motes.t += dt;
      var p = motes.pos;
      for (var i = 0; i < motes.n; i++) {
        var sd = motes.seed[i];
        p[i * 3] += Math.sin(motes.t * 0.23 + sd) * dt * 0.08;
        p[i * 3 + 1] += (Math.sin(motes.t * 0.17 + sd * 1.7) * 0.05 + 0.02) * dt;
        p[i * 3 + 2] += Math.cos(motes.t * 0.19 + sd) * dt * 0.06;
        if (p[i * 3 + 1] > 4.2) p[i * 3 + 1] = 0.5;
      }
      motes.points.geometry.attributes.position.needsUpdate = true;
      // The lamp breathes very slightly (well under a flicker).
      key.intensity = 1.35 * (1 + Math.sin(motes.t * 0.6) * 0.015);
    }

    // ---------------------------------------------------------------- camera

    function fitCamera(aspect) {
      // Framing constants from CAMERA; fit the 10.6-wide board and its depth.
      var needW = 10.7, needH = 8.8;
      var vFit = needH / (2 * Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2)));
      var hFit = needW / (2 * Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2)) * aspect);
      var dist = Math.max(vFit, hFit) * 1.0;
      var t = dist / CAMERA.dist;
      camera.position.set(0, CAMERA.height * t, CAMERA.back * t);
      camera.lookAt(0, 0, CAMERA.lookZ);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      // Fog begins just past the board, whatever the framing distance.
      if (scene.fog) {
        var d = camera.position.length();
        scene.fog.near = d * 1.25;
        scene.fog.far = d * 2.6;
      }
    }

    function resetCamera() {
      fitCamera(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    }

    // Camera nudge (event-tiered shake): low amplitude, reduced-motion aware,
    // never changes raycast truth because picking uses logical state.
    function nudge(strength) {
      if (reducedMotion) return;
      var base = camera.position.clone();
      tweener.add({
        duration: 0.22, tag: 'shake',
        update: function (k) {
          var amp = (1 - k) * 0.05 * strength;
          camera.position.x = base.x + Math.sin(k * 31) * amp;
          camera.position.z = base.z + Math.cos(k * 27) * amp * 0.6;
        },
        done: function () { camera.position.copy(base); }
      });
    }

    // ---------------------------------------------------------------- sync

    // Where does each card live in this state? cardId -> { loc, depth }
    function locateCards(s) {
      var map = new Map();
      s.cells.forEach(function (id, i) { if (id !== null) map.set(id, { loc: { zone: 'cell', index: i }, depth: 0 }); });
      s.foundations.forEach(function (f, i) { f.forEach(function (id, d) { map.set(id, { loc: { zone: 'foundation', index: i }, depth: d }); }); });
      s.tableau.forEach(function (col, i) { col.forEach(function (id, d) { map.set(id, { loc: { zone: 'tableau', index: i }, depth: d }); }); });
      return map;
    }

    // Bring meshes in line with a new immutable snapshot. Moves animate;
    // skip/fast-forward settles everything to the exact deterministic end.
    function syncState(newState, opts) {
      opts = opts || {};
      var instant = reducedMotion || opts.instant;
      var prevMap = state ? locateCards(state) : new Map();
      var nextMap = locateCards(newState);
      state = newState;

      nextMap.forEach(function (dst, cardId) {
        var entry = cardMeshes.get(cardId);
        if (!entry) {
          var mesh = makeCardMesh(cardId);
          scene.add(mesh);
          entry = { mesh: mesh, loc: null, depth: 0 };
          cardMeshes.set(cardId, entry);
        }
        var prev = prevMap.get(cardId);
        var target = locToWorld(dst.loc, dst.depth);
        entry.loc = dst.loc;
        entry.depth = dst.depth;
        // Foundations stack flat.
        if (dst.loc.zone === 'foundation') target.y = 0.02 + dst.depth * 0.012;

        var moved = !prev || prev.loc.zone !== dst.loc.zone || prev.loc.index !== dst.loc.index || prev.depth !== dst.depth;
        if (moved) {
          var from = { x: entry.mesh.position.x, y: entry.mesh.position.y, z: entry.mesh.position.z };
          if (instant || (from.x === 0 && from.y === 0 && from.z === 0)) {
            entry.mesh.position.set(target.x, target.y, target.z);
          } else {
            var mesh = entry.mesh;
            var lift = 0.5 + Math.abs(target.x - from.x) * 0.06;
            animating.add(cardId);
            tweener.cancelByTag('card-' + cardId);
            tweener.add({
              duration: 0.24 + Math.min(0.18, Math.abs(target.x - from.x) * 0.03),
              tag: 'card-' + cardId,
              update: function (k) {
                mesh.position.x = from.x + (target.x - from.x) * k;
                mesh.position.z = from.z + (target.z - from.z) * k;
                mesh.position.y = from.y + (target.y - from.y) * k + Math.sin(k * Math.PI) * lift;
              },
              done: function () {
                animating.delete(cardId);
                mesh.position.set(target.x, target.y, target.z);
              }
            });
          }
        } else if (!selectedCardIds.has(cardId)) {
          entry.mesh.position.set(target.x, target.y, target.z);
        }
        // Render order for correct overlap within columns.
        entry.mesh.renderOrder = dst.loc.zone === 'tableau' ? dst.depth : dst.depth;
      });
      applySelectionLift();
    }

    // ---------------------------------------------------------------- selection & input

    var selectedCardIds = new Set();
    var selectedLoc = null;
    var drag = null; // { cardIds, pointerId, offsetX, offsetZ, startX, startY, moved }

    var animating = new Set(); // cardIds with an active move tween

    function applySelectionLift() {
      cardMeshes.forEach(function (entry, cardId) {
        if (!entry.loc || animating.has(cardId)) return;
        var base = locToWorld(entry.loc, entry.depth);
        if (entry.loc.zone === 'foundation') base.y = 0.02 + entry.depth * 0.012;
        var mats = entry.mesh.material;
        if (selectedCardIds.has(cardId)) {
          if (!drag || !drag.cardIds.has(cardId)) entry.mesh.position.y = base.y + LAYOUT.liftY;
          mats[0].emissive = new THREE.Color(theme.accent);
          mats[0].emissiveIntensity = 0.22;
        } else {
          if (!drag || !drag.cardIds.has(cardId)) entry.mesh.position.y = base.y;
          mats[0].emissiveIntensity = 0;
        }
      });
    }

    function setSelection(loc, cardIds) {
      selectedLoc = loc;
      selectedCardIds = new Set(cardIds || []);
      setSelectionMarker(loc);
      applySelectionLift();
    }

    var raycaster = new THREE.Raycaster();
    var pointerNdc = new THREE.Vector2();
    var dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3);

    function pick(clientX, clientY, exclude) {
      var rect = canvas.getBoundingClientRect();
      pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);
      // Explicit interaction layers only: cards first, then slots.
      var meshes = [];
      cardMeshes.forEach(function (e) {
        if (!exclude || !exclude.has(e.mesh.userData.cardId)) meshes.push(e.mesh);
      });
      var hits = raycaster.intersectObjects(meshes, false);
      if (hits.length) {
        // Topmost card wins: highest y, then nearest.
        hits.sort(function (a, b) { return (b.object.position.y - a.object.position.y) || (a.distance - b.distance); });
        return { kind: 'card', cardId: hits[0].object.userData.cardId, point: hits[0].point };
      }
      var slotHit = raycaster.intersectObjects(slotMeshes.map(function (s) { return s.mesh; }), false);
      if (slotHit.length) return { kind: 'slot', loc: slotHit[0].object.userData.loc, point: slotHit[0].point };
      return null;
    }

    function planePoint(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);
      var out = new THREE.Vector3();
      raycaster.ray.intersectPlane(dragPlane, out);
      return out;
    }

    // Tap/drag distinction by distance and time thresholds (spec §3).
    var TAP_DIST = 8, TAP_MS = 350;

    function onPointerDown(ev) {
      if (!state || state.status !== 'active') return;
      var hit = pick(ev.clientX, ev.clientY);
      if (!hit) return;
      canvas.setPointerCapture && canvas.setPointerCapture(ev.pointerId);
      if (hit.kind === 'card') {
        var entry = cardMeshes.get(hit.cardId);
        var ids = new Set([hit.cardId]);
        var depth0 = entry ? entry.depth : 0;
        // Grabbing a card inside an ordered run lifts the whole run above it.
        if (entry && entry.loc && entry.loc.zone === 'tableau') {
          var col = state.tableau[entry.loc.index];
          var runLen = global.OCRules.orderedRunLength(col);
          var runStart = col.length - runLen;
          if (depth0 >= runStart) {
            for (var d = depth0; d < col.length; d++) ids.add(col[d]);
          } else {
            // Buried card: the press applies to the column's movable top card.
            ids = new Set([col[col.length - 1]]);
            depth0 = col.length - 1;
          }
        }
        drag = {
          pointerId: ev.pointerId,
          cardId: hit.cardId,
          startX: ev.clientX, startY: ev.clientY,
          moved: false,
          cardIds: ids,
          depth0: depth0
        };
        if (pointerCb) pointerCb({ type: 'press-card', cardId: hit.cardId });
      } else if (pointerCb) {
        pointerCb({ type: 'press-slot', loc: hit.loc });
      }
    }

    function onPointerMove(ev) {
      if (!drag || drag.pointerId !== ev.pointerId) return;
      var dx = ev.clientX - drag.startX, dy = ev.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > TAP_DIST) {
        drag.moved = true;
        if (pointerCb) pointerCb({ type: 'drag-start', cardId: drag.cardId });
      }
      if (drag.moved) {
        var p = planePoint(ev.clientX, ev.clientY);
        var ids = drag.cardIds;
        cardMeshes.forEach(function (entry, cardId) {
          if (ids.has(cardId)) {
            entry.mesh.position.x = p.x;
            entry.mesh.position.z = p.z + (entry.depth - drag.depth0) * LAYOUT.stackDY;
            entry.mesh.position.y = 0.4;
          }
        });
        // Target preview under the pointer (dragged cards excluded from picking).
        var hit = pick(ev.clientX, ev.clientY, ids);
        if (pointerCb) pointerCb({ type: 'drag-over', hit: hit && hit.kind === 'slot' ? hit.loc : (hit && hit.kind === 'card' ? cardLocOf(hit.cardId) : null) });
      }
    }

    function onPointerUp(ev) {
      if (!drag || drag.pointerId !== ev.pointerId) return;
      canvas.releasePointerCapture && canvas.releasePointerCapture(ev.pointerId);
      var wasDrag = drag.moved;
      var cardId = drag.cardId;
      var draggedIds = drag.cardIds;
      drag = null;
      if (wasDrag) {
        var hit = pick(ev.clientX, ev.clientY, draggedIds);
        var to = null;
        if (hit) to = hit.kind === 'slot' ? hit.loc : cardLocOf(hit.cardId);
        if (pointerCb) pointerCb({ type: 'drop', cardId: cardId, to: to, cardIds: Array.from(draggedIds) });
      } else {
        if (pointerCb) pointerCb({ type: 'tap-card', cardId: cardId });
      }
    }

    function onPointerCancel(ev) {
      if (drag && drag.pointerId === ev.pointerId) {
        drag = null;
        if (pointerCb) pointerCb({ type: 'drag-cancel' });
        syncState(state, { instant: true });
      }
    }

    function cardLocOf(cardId) {
      var e = cardMeshes.get(cardId);
      return e && e.loc ? e.loc : null;
    }

    function attachPointer() {
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerCancel);
      canvas.addEventListener('lostpointercapture', onPointerCancel);
    }

    // ---------------------------------------------------------------- theme & quality

    function disposeGroup(group) {
      group.traverse(function (obj) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(function (m) {
            if (m.map) m.map.dispose();
            m.dispose();
          });
        }
      });
    }

    function refreshCardFaces() {
      cardMeshes.forEach(function (entry) {
        var mats = entry.mesh.material;
        var old = mats[0];
        var fresh = makeFaceMat(entry.mesh.userData.cardId);
        fresh.emissive.copy(old.emissive);
        fresh.emissiveIntensity = old.emissiveIntensity;
        mats[0] = fresh;
        entry.mesh.userData.faceMat = fresh;
        old.dispose();
      });
    }

    function rebuildForTheme() {
      // Textures depend on theme colors; regenerate cards and environment.
      disposeTextures();
      refreshCardFaces();
      // Rebuild environment materials in place.
      while (envGroup.children.length) {
        var child = envGroup.children.pop();
        disposeGroup(child);
      }
      slotMeshes.length = 0;
      buildEnvironment();
      ensureMarkers();
      allMarkers().forEach(function (m) { tuneMarker(m.material); });
      particleLook();
      if (state) syncState(state, { instant: true });
    }

    // ---------------------------------------------------------------- graphics settings

    var composer = null, gradePass = null, postKey = null, postFailed = false, addons = null;
    var pixelRatio = 1, size = [0, 0], adaptiveScale = 1, frames = [], fps = 0;

    /** Apply saved graphics settings live (no reload). */
    function setGraphics(saved) {
      var json = JSON.stringify(saved || {});
      if (json === gfxJson) return; // unrelated settings changed
      gfxJson = json;
      savedGfx = saved || {};
      var prev = q;
      q = G.resolve(savedGfx, detected);
      canvas.dataset.gfxPreset = q.preset;
      document.body.dataset.gfxPreset = q.preset;

      var sizePx = G.SHADOW_MAP[q.shadows];
      var shadowsOn = sizePx > 0;
      var shadowToggle = renderer.shadowMap.enabled !== shadowsOn;
      renderer.shadowMap.enabled = shadowsOn;
      key.castShadow = shadowsOn;
      if (shadowsOn && key.shadow.mapSize.x !== sizePx) {
        key.shadow.mapSize.set(sizePx, sizePx);
        if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
      }
      cardMeshes.forEach(function (e) { e.mesh.castShadow = shadowsOn; });
      if (shadowToggle) {
        // Materials pick up shadow-map changes on recompile.
        scene.traverse(function (o) {
          if (!o.material) return;
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.needsUpdate = true; });
        });
      }

      if (q.reflections === 'on') ensureEnvironment();
      applyEnvironment();
      if (prev.detail !== q.detail || prev.reflections !== q.reflections) {
        // Surface textures and card materials depend on these tiers.
        disposeTextures();
        refreshCardFaces();
        while (envGroup.children.length) disposeGroup(envGroup.children.pop());
        slotMeshes.length = 0;
        buildEnvironment();
      }
      if (q.post) loadAddons().then(function (A) { addons = A; postKey = null; }, function () { postFailed = true; });
      adaptiveScale = 1;
      frames = [];
      postKey = null; // rebuild the post chain on the next frame
      fpsVisible(q.showFps);
    }

    function fpsVisible(on) {
      var el = document.getElementById('fps-meter');
      if (on && !el) {
        el = document.createElement('div');
        el.id = 'fps-meter';
        el.setAttribute('aria-hidden', 'true');
        (canvas.parentElement || document.body).appendChild(el);
      }
      if (el) el.hidden = !on;
    }

    function computePostKey(w, h) {
      if (!q.post || !addons) return 'none';
      return [q.bloom, q.grade, q.antialias, w, h, pixelRatio].join('|');
    }

    function buildPost(w, h) {
      if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); composer.passes.forEach(function (p) { if (p.dispose) p.dispose(); }); }
      composer = null;
      gradePass = null;
      if (q.post && addons && !postFailed) {
        try {
          var A = addons;
          var pw = Math.max(1, Math.round(w * pixelRatio)), ph = Math.max(1, Math.round(h * pixelRatio));
          var target = new THREE.WebGLRenderTarget(pw, ph, {
            type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0
          });
          var c = new A.EffectComposer(renderer, target);
          c.setPixelRatio(pixelRatio);
          c.setSize(w, h);
          c.addPass(new A.RenderPass(scene, camera));
          if (q.bloom === 'on') {
            // High threshold: tone-mapped surfaces stay below it, so only
            // the untone-mapped accents (markers, sparks) glow.
            c.addPass(new A.UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.45, 0.9));
          }
          gradePass = new A.ShaderPass(GradeShader);
          gradePass.uniforms.uAmount.value = q.grade === 'on' ? 1 : 0;
          gradePass.uniforms.uVignette.value = q.grade === 'on' ? 0.24 : 0;
          c.addPass(gradePass);
          if (q.antialias === 'smaa') c.addPass(new A.SMAAPass(pw, ph));
          if (q.antialias === 'fxaa') {
            var fxaa = new A.ShaderPass(A.FXAAShader);
            fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
            c.addPass(fxaa);
          }
          composer = c;
        } catch (e) {
          // Post-processing is an enhancement: render directly without it.
          postFailed = true;
          composer = null;
        }
      }
      // Glow tuning depends on whether a bloom chain actually exists.
      allMarkers().forEach(function (m) { tuneMarker(m.material); });
      particleLook();
    }

    // Adaptive resolution: step the scale down when frames are slow, back up
    // when they are fast. Returns true when the scale changed.
    function adapt(dtMs) {
      frames.push(dtMs);
      if (frames.length < 90) return false;
      var sum = 0;
      for (var i = 0; i < frames.length; i++) sum += frames[i];
      var avg = sum / frames.length;
      frames = [];
      fps = 1000 / avg;
      var el = document.getElementById('fps-meter');
      if (el && !el.hidden) el.textContent = Math.round(fps) + ' fps · ' + (Math.round(pixelRatio * 100) / 100) + '×';
      if (!q.adaptive) return false;
      var before = adaptiveScale;
      if (avg > 26) adaptiveScale = Math.max(0.6, adaptiveScale - 0.1);
      else if (avg < 14 && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + 0.05);
      return before !== adaptiveScale;
    }

    function graphicsInfo() {
      return {
        gpu: gpu,
        detected: detected,
        resolved: q,
        pixels: [Math.round(size[0] * pixelRatio), Math.round(size[1] * pixelRatio)],
        fps: Math.round(fps),
        adaptiveScale: Math.round(adaptiveScale * 100) / 100,
        postFailed: postFailed
      };
    }

    // ---------------------------------------------------------------- loop

    var running = false;
    var rafId = 0;

    function draw(dtMs) {
      var rescale = adapt(dtMs);
      var w = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 1;
      var h = canvas.clientHeight || (canvas.parentElement && canvas.parentElement.clientHeight) || 1;
      var dpr = global.devicePixelRatio || 1;
      var ratio = Math.min(dpr, q.dprCap) * q.scale * adaptiveScale;
      if (w !== size[0] || h !== size[1] || ratio !== pixelRatio || rescale) {
        size = [w, h];
        pixelRatio = ratio;
        renderer.setPixelRatio(ratio);
        renderer.setSize(w, h, false);
        fitCamera(w / Math.max(1, h));
      }
      var k = computePostKey(w, h);
      if (k !== postKey) {
        postKey = k;
        buildPost(w, h);
      }
      if (composer) composer.render(dtMs / 1000);
      else renderer.render(scene, camera);
    }

    function frame(t) {
      if (!running || destroyed) return;
      rafId = requestAnimationFrame(frame);
      var dtMs = (t - clock.last) || 16;
      var dt = Math.min(0.05, dtMs / 1000);
      clock.last = t;
      tweener.update(dt);
      updateParticles(dt);
      updateMotes(dt);
      draw(Math.min(250, dtMs));
    }

    function start() {
      if (running) return;
      running = true;
      clock.last = performance.now();
      rafId = requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    function resize() {
      var w = canvas.clientWidth || canvas.parentElement.clientWidth;
      var h = canvas.clientHeight || canvas.parentElement.clientHeight;
      size = [w, h];
      pixelRatio = Math.min(global.devicePixelRatio || 1, q.dprCap) * q.scale * adaptiveScale;
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(w, h, false);
      fitCamera(w / Math.max(1, h));
    }

    // WebGL context recovery: GPU resources rebuild from CPU descriptors
    // (every mesh/texture is procedural and regenerable from `state`).
    function attachContextRecovery() {
      canvas.addEventListener('webglcontextlost', function (ev) {
        ev.preventDefault();
        stop();
      });
      canvas.addEventListener('webglcontextrestored', function () {
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        disposeTextures();
        composer = null; postKey = null; envRT = null;
        gfxJson = null;
        setGraphics(savedGfx);
        resize();
        if (state) syncState(state, { instant: true });
        start();
      });
    }

    // ---------------------------------------------------------------- init

    buildEnvironment();
    ensureMarkers();
    attachPointer();
    attachContextRecovery();
    // First application of the saved graphics settings (q already resolves
    // them, so this wires shadows/post/env without rebuilding the scene).
    setGraphics(savedGfx);
    resize();

    return {
      LAYOUT: LAYOUT,
      locToWorld: locToWorld,
      syncState: syncState,
      settle: function () { tweener.settle(); },
      setSelection: setSelection,
      setLegalTargets: setLegalTargets,
      clearLegalTargets: function () { setLegalTargets([]); },
      setTheme: function (t) { if (t === theme) return; theme = t; rebuildForTheme(); },
      setGraphics: setGraphics,
      graphicsInfo: graphicsInfo,
      setReducedMotion: function (v) { reducedMotion = !!v; },
      playEvent: function (event, data) {
        if (event === 'foundation' && data && data.loc) {
          var p = locToWorld(data.loc, 0);
          burst(p.x, 0.3, p.z, 40);
        } else if (event === 'win') {
          for (var i = 0; i < 4; i++) {
            var fp = locToWorld({ zone: 'foundation', index: i }, 0);
            burst(fp.x, 0.4, fp.z, 100);
          }
          nudge(1.5);
        } else if (event === 'invalid') nudge(0.6);
      },
      onPointerAction: function (cb) { pointerCb = cb; },
      cardLocOf: cardLocOf,
      start: start,
      stop: stop,
      resize: resize,
      resetCamera: resetCamera,
      isAnimating: function () { return tweener.count() > 0; },
      dispose: function () {
        destroyed = true;
        stop();
        canvas.removeEventListener('pointerdown', onPointerDown);
        disposeGroup(envGroup);
        cardMeshes.forEach(function (e) { disposeGroup(e.mesh); });
        disposeTextures();
        if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); }
        if (envRT) envRT.dispose();
        renderer.dispose();
      }
    };
  }

  global.OCRender = {
    LAYOUT: LAYOUT,
    createRenderer: createRenderer,
    isSupported: function () {
      try {
        var cv = document.createElement('canvas');
        return !!(global.THREE && (cv.getContext('webgl2') || cv.getContext('webgl')));
      } catch (e) { return false; }
    }
  };
})(typeof self !== 'undefined' ? self : this);
