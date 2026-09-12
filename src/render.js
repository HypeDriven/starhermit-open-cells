/*
 * Open Cells — render layer (Three.js).
 * Brass-and-slate strategy desk: authored camera, procedural geometry and
 * canvas-texture card faces, PBR lighting with one dominant key, pooled
 * particles, quality tiers, explicit disposal, WebGL context recovery.
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

  function cardTexture(cardId, theme) {
    var key = theme.id + '/' + cardId;
    if (textureCache.has(key)) return textureCache.get(key);
    var W = 128, H = 184;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
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
    tex.anisotropy = 4;
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

  function createRenderer(canvas, options) {
    options = options || {};
    var theme = options.theme;
    var reducedMotion = !!options.reducedMotion;
    var quality = options.quality || 'medium';

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: quality !== 'low', alpha: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = quality !== 'low';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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

    // ---- lighting: one dominant key, soft fill, contact grounding
    var hemi = new THREE.HemisphereLight(0xfff2dd, 0x20262e, 0.55);
    scene.add(hemi);
    var key = new THREE.DirectionalLight(0xffe8c0, 1.35);
    key.position.set(4, 9, 3);
    key.castShadow = quality !== 'low';
    key.shadow.mapSize.setScalar(quality === 'high' ? 2048 : 1024);
    key.shadow.camera.left = -7; key.shadow.camera.right = 7;
    key.shadow.camera.top = 7; key.shadow.camera.bottom = -7;
    key.shadow.bias = -0.0005;
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xb0c4de, 0.25);
    fill.position.set(-5, 6, -2);
    scene.add(fill);

    // ---- environment group (disposed wholesale on teardown)
    var envGroup = new THREE.Group();
    scene.add(envGroup);

    function buildEnvironment() {
      // Slate desk slab.
      var deskMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.desk), roughness: 0.85, metalness: 0.05 });
      var desk = new THREE.Mesh(new THREE.BoxGeometry(11.4, 0.3, 9.6), deskMat);
      desk.position.y = -0.16;
      desk.receiveShadow = true;
      envGroup.add(desk);

      // Brass trim strips framing the play area.
      var trimMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.deskTrim), roughness: 0.32, metalness: 0.9 });
      var trimGeomH = new THREE.BoxGeometry(10.6, 0.045, 0.09);
      var trimGeomV = new THREE.BoxGeometry(0.09, 0.045, 8.4);
      [[0, -4.05, trimGeomH], [0, 3.75, trimGeomH], [-5.25, -0.15, trimGeomV], [5.25, -0.15, trimGeomV]].forEach(function (t) {
        var m = new THREE.Mesh(t[2], trimMat);
        m.position.set(t[0], 0.012, t[1]);
        envGroup.add(m);
      });

      // Cloth inlay under the columns.
      var clothMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.cloth), roughness: 0.95, metalness: 0 });
      var cloth = new THREE.Mesh(new THREE.BoxGeometry(9.9, 0.02, 6.2), clothMat);
      cloth.position.set(0, 0.002, 0.6);
      cloth.receiveShadow = true;
      envGroup.add(cloth);

      // Slot recesses: 4 cells + 4 foundations + 8 column guides.
      var slotMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.slot), roughness: 0.9, metalness: 0.1 });
      var slotFrameMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.deskTrim), roughness: 0.4, metalness: 0.8 });
      var slotGeom = new THREE.BoxGeometry(LAYOUT.cardW + 0.1, 0.014, LAYOUT.cardH + 0.1);
      var frameGeom = new THREE.BoxGeometry(LAYOUT.cardW + 0.18, 0.01, LAYOUT.cardH + 0.18);
      function addSlot(x, z, loc, kind) {
        var frame = new THREE.Mesh(frameGeom, slotFrameMat);
        frame.position.set(x, 0.004, z);
        var inner = new THREE.Mesh(slotGeom, slotMat.clone());
        inner.position.set(x, 0.012, z);
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

    function makeCardMesh(cardId) {
      var face = cardTexture(cardId, theme);
      var back = backTexture(theme);
      var sideMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c2, roughness: 0.6, metalness: 0 });
      var faceMat = new THREE.MeshStandardMaterial({ map: face, roughness: 0.55, metalness: 0.02 });
      var backMat = new THREE.MeshStandardMaterial({ map: back, roughness: 0.6, metalness: 0.05 });
      // ExtrudeGeometry groups: 0 = front/back caps... use multi-material:
      // [cap(front), side]. We assign face to cap; back is hidden (face-up game),
      // but keep a distinct back material for deal animations.
      var mesh = new THREE.Mesh(sharedCardGeom, [faceMat, sideMat]);
      mesh.castShadow = quality !== 'low';
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

    function ensureMarkers() {
      if (!markerMeshes.selection) {
        var mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent), transparent: true, opacity: 0.85, side: THREE.DoubleSide });
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

    // ---- particles: bounded pool, cosmetic only, never raycast targets
    var particlePool = null;
    function ensureParticles() {
      if (particlePool) return;
      var MAX = 400; // well under the 5k mobile budget
      var geom = new THREE.BufferGeometry();
      var pos = new Float32Array(MAX * 3);
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      var mat = new THREE.PointsMaterial({ color: new THREE.Color(theme.accent), size: 0.06, transparent: true, opacity: 0.9, depthWrite: false });
      var points = new THREE.Points(geom, mat);
      points.visible = false;
      points.raycast = function () {}; // cosmetic particles never intercept raycasts
      scene.add(points);
      particlePool = { points: points, pos: pos, vel: new Float32Array(MAX * 3), life: new Float32Array(MAX), active: false, max: MAX };
    }

    function burst(x, y, z, count) {
      if (reducedMotion || quality === 'low') return;
      ensureParticles();
      var p = particlePool;
      var n = Math.min(count, p.max);
      for (var i = 0; i < n; i++) {
        p.pos[i * 3] = x; p.pos[i * 3 + 1] = y; p.pos[i * 3 + 2] = z;
        var a = (i / n) * Math.PI * 2;
        var r = 0.8 + ((i * 7919) % 100) / 250;
        p.vel[i * 3] = Math.cos(a) * r;
        p.vel[i * 3 + 1] = 1.6 + ((i * 104729) % 100) / 120;
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
        if (p.life[i] <= 0) continue;
        any = true;
        p.life[i] -= dt * 1.4;
        p.vel[i * 3 + 1] -= dt * 3.2;
        p.pos[i * 3] += p.vel[i * 3] * dt;
        p.pos[i * 3 + 1] = Math.max(0.02, p.pos[i * 3 + 1] + p.vel[i * 3 + 1] * dt);
        p.pos[i * 3 + 2] += p.vel[i * 3 + 2] * dt;
      }
      p.points.geometry.attributes.position.needsUpdate = true;
      if (!any) { p.active = false; p.points.visible = false; }
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

    function rebuildForTheme() {
      // Textures depend on theme colors; regenerate cards and environment.
      disposeTextures();
      cardMeshes.forEach(function (entry) {
        var face = cardTexture(entry.mesh.userData.cardId, theme);
        entry.mesh.userData.faceMat.map = face;
        entry.mesh.userData.faceMat.needsUpdate = true;
      });
      // Rebuild environment materials in place.
      while (envGroup.children.length) {
        var child = envGroup.children.pop();
        disposeGroup(child);
      }
      slotMeshes.length = 0;
      buildEnvironment();
      ensureMarkers();
      if (markerMeshes.selection) markerMeshes.selection.material.color.set(theme.accent);
      targetMarkers.forEach(function (m) { m.material.color.set(theme.accent); });
      if (particlePool) particlePool.points.material.color.set(theme.accent);
      if (state) syncState(state, { instant: true });
    }

    function applyQuality(q) {
      quality = q;
      var dpr = global.devicePixelRatio || 1;
      var cap = q === 'low' ? 1 : (q === 'medium' ? 1.5 : 2);
      renderer.setPixelRatio(Math.min(dpr, cap));
      renderer.shadowMap.enabled = q !== 'low';
      key.castShadow = q !== 'low';
      key.shadow.mapSize.setScalar(q === 'high' ? 2048 : 1024);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
      cardMeshes.forEach(function (e) { e.mesh.castShadow = q !== 'low'; });
    }

    // ---------------------------------------------------------------- loop

    var running = false;
    var rafId = 0;

    function frame(t) {
      if (!running || destroyed) return;
      rafId = requestAnimationFrame(frame);
      var dt = Math.min(0.05, (t - clock.last) / 1000 || 0.016);
      clock.last = t;
      tweener.update(dt);
      updateParticles(dt);
      renderer.render(scene, camera);
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
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: quality !== 'low' });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.shadowMap.enabled = quality !== 'low';
        disposeTextures();
        applyQuality(quality);
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
    resize();

    return {
      LAYOUT: LAYOUT,
      locToWorld: locToWorld,
      syncState: syncState,
      settle: function () { tweener.settle(); },
      setSelection: setSelection,
      setLegalTargets: setLegalTargets,
      clearLegalTargets: function () { setLegalTargets([]); },
      setTheme: function (t) { theme = t; rebuildForTheme(); },
      setQuality: applyQuality,
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
