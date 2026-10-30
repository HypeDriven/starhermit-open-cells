// The brass-and-slate desk on starhermit:scene, as the browser build's
// src/render.js drew it with three.js r152: the authored camera, the walnut
// surround with its baked lamp pool (vertex colours), the slate slab, the
// brass trim, the cloth inlay, the slot recesses (4 cells, 4 foundations,
// 8 column guides), the 52 extruded rounded cards (face textures in an atlas
// per theme and surface detail), the selection ring and lift with its accent
// glow, the legal-target rings, the foundation sparks and the win bursts,
// the dust motes and the breathing lamp, the camera nudge on invalid moves
// and wins, the warm key light with shadows, the hemisphere and cool fill,
// and the room environment's reflections; moves animate on authored tweens
// (lift arc, ease in-out) that a press or Settle fast-forwards. The table is
// framed in the playfield rectangle the top bar, rails and tray leave
// (setViewOffset), as the DOM canvas sat between them.
//
// From three.js r152 (legacy lights, colour management on): at engine.minor
// 26+ punctual lights follow r155+, so every intensity is the page's × π
// (LEGACY); the page's own fitted shadow box and bias; RoomEnvironment() as
// r152 called it; reflections are each material's own envMap with its
// envMapIntensity (scene.environment ignores per-material intensity). r152 tone-mapped the scene draw (ACES at 1.05) into its
// composer, whose GradeShader output pass graded and vignetted it; the
// runtime's renderer.bloom / grade / antialias do that (bloom before tone
// mapping, so its threshold is the old one taken back through the curve).
// The procedural canvases (card faces, slate, felt and wood) are baked images
// (tools/bake-textures.mjs). Adaptive resolution, the pixel-ratio cap and the
// frame-rate readout are the runtime's. Rendering never touches the rules state.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, DirectionalLight,
  DoubleSide, ExtrudeGeometry, Fog, Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, OrthographicCamera,
  MeshStandardMaterial, NormalBlending, PerspectiveCamera, PlaneGeometry, Plane, PMREMGenerator, Points, PointsMaterial, Raycaster,
  RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace, Shape, TextureLoader, Vector2, Vector3, pointerToNdc, renderer, scene,
  type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { Content, Rules, type Loc, type State, type Theme } from "./classic.ts";
import { MOTE_MAX, SPARK_MAX, sparkCap, type Look } from "./quality.ts";

// ---------------------------------------------------------------- layout model
// render.js LAYOUT: all positions derive from these constants.
export const LAYOUT = {
  cardW: 0.92, cardH: 1.3, cardD: 0.024,
  gapX: 0.16,
  topRowZ: -3.1,
  colTopZ: -1.35,
  stackDY: 0.36,
  stackRise: 0.006,
  liftY: 0.22,
};
const CAMERA = { fov: 30, dist: 10.4, height: 8.2, back: 4.6, lookZ: 0.45 };
const columnX = (i: number): number => (i - 3.5) * (LAYOUT.cardW + LAYOUT.gapX);
function slotX(i: number, right: boolean): number {
  const step = LAYOUT.cardW + LAYOUT.gapX;
  return right ? 3.5 * step - i * step : -3.5 * step + i * step;
}
/** World position for a logical location + stack depth. */
export function locToWorld(loc: Loc, depth = 0): { x: number; y: number; z: number } {
  if (loc.zone === "cell") return { x: slotX(loc.index, false), y: 0.02, z: LAYOUT.topRowZ };
  if (loc.zone === "foundation") return { x: slotX(loc.index, true), y: 0.02, z: LAYOUT.topRowZ };
  return { x: columnX(loc.index), y: 0.02 + depth * LAYOUT.stackRise, z: LAYOUT.colTopZ + depth * LAYOUT.stackDY };
}
function restPos(loc: Loc, depth: number): { x: number; y: number; z: number } {
  const p = locToWorld(loc, depth);
  if (loc.zone === "foundation") p.y = 0.02 + depth * 0.012; // foundations stack flat
  return p;
}

// ---------------------------------------------------------------- the scene's fixed parts
const camera = new PerspectiveCamera(CAMERA.fov, 1, 0.1, 100);
const raycaster = new Raycaster();
/** r152 legacy light units → r155+ physical: × π. */
const LEGACY = Math.PI;
const hemi = new HemisphereLight(0xfff2dd, 0x20262e, 0.55 * LEGACY);
const key = new DirectionalLight(0xffe8c0, 1.35 * LEGACY);
key.position.set(4, 9, 3);
key.target.position.set(0, 0, 0.1);
const shadowCam = key.shadow.camera as OrthographicCamera;
Object.assign(shadowCam, { left: -6.6, right: 6.6, top: 5.6, bottom: -5.6, near: 4, far: 18 });
shadowCam.updateProjectionMatrix();
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.01;
key.shadow.radius = 3;
const fill = new DirectionalLight(0xb0c4de, 0.25 * LEGACY);
fill.position.set(-5, 6, -2);
scene.add(hemi, key, key.target, fill);

let look: Look | null = null;
let theme: Theme = Content.THEMES[0]!;
let reducedMotion = false;
/** The suit colour palette (standard, deuteranopia, tritanopia). */
let palette = "standard";
let envGroup: Group | null = null;
let envTexture: Texture | null = null;
let state: State | null = null;

// ---------------------------------------------------------------- textures
const loader = new TextureLoader();
const textures = new Map<string, Texture>();
/** A package image (cached per path and repeat; a repeat > 0 wraps). */
function image(path: string, rx = 0, ry = 0, aniso = 4): Texture {
  const k = `${path}|${rx}|${ry}`;
  let t = textures.get(k);
  if (!t) {
    t = loader.load(path, undefined, undefined, (e: unknown) => console.warn(`${path}: ${e instanceof Error ? e.message : String(e)}`));
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = aniso;
    if (rx > 0) { t.wrapS = t.wrapT = RepeatWrapping; t.repeat.set(rx, ry); }
    textures.set(k, t);
  }
  return t;
}
/** render.js spriteTexture: the sparks' and motes' soft round sprite. */
const spriteTex = (() => {
  const cv = new OffscreenCanvas(64, 64), g = cv.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(cv);
})();
function envMap(): Texture | null {
  if (!envTexture) {
    try { envTexture = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTexture;
}

// ---------------------------------------------------------------- materials
type AnyMat = MeshStandardMaterial | MeshLambertMaterial;
/** Desk materials per the budget: Lambert on Low, Standard above; surface textures at the budget's size (Detailed),
 * the fine slate / felt bump on High and Ultra (render.js envMat). */
function envMat(color: Color | string, rough: number, metal: number, envI: number, texKind?: "wood" | "slate" | "felt", repeat?: [number, number]): AnyMat {
  const b = look!.budget;
  const c = new Color(color);
  const m: AnyMat = b.material === "lambert"
    ? new MeshLambertMaterial({ color: c })
    : new MeshStandardMaterial({ color: c, roughness: rough, metalness: metal, envMapIntensity: envI });
  if (texKind && look!.detailed) {
    const size = texKind === "wood" ? b.texture : b.texture / 2;
    const t = image(`assets/textures/${texKind}-${size}.png`, repeat![0], repeat![1]);
    m.map = t;
    if (texKind !== "wood" && b.surfBump && m instanceof MeshStandardMaterial) { m.bumpMap = t; m.bumpScale = texKind === "felt" ? 0.05 : 0.03; }
  }
  return m;
}


// ---------------------------------------------------------------- the desk
interface Slot { mesh: Mesh; loc: Loc }
let slotMeshes: Slot[] = [];
function disposeTree(root: Object3D): void {
  const geos = new Set<BufferGeometry>(), mats = new Set<Material>();
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) geos.add(m.geometry);
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
  });
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
}
/** render.js buildEnvironment. */
function buildEnvironment(): void {
  if (envGroup) { scene.remove(envGroup); disposeTree(envGroup); }
  const grp = envGroup = new Group();
  scene.add(grp);
  slotMeshes = [];
  // Room: dark background with fog so the walnut surround fades out.
  const bg = new Color(theme.desk).multiplyScalar(0.28);
  scene.background = bg;
  scene.fog = new Fog(bg.clone(), 16, 34);
  frameKey = "";

  // Walnut desktop around the slate slab, lit by a baked lamp pool.
  const woodCol = new Color(theme.desk).lerp(new Color(0x3a2a1c), 0.65);
  const surroundMat = envMat(woodCol, 0.62, 0, 0.25, "wood", [12, 12]);
  surroundMat.vertexColors = true;
  const [px, pz] = look!.budget.pool;
  const surroundGeom = new PlaneGeometry(120, 100, px, pz);
  surroundGeom.rotateX(-Math.PI / 2);
  const sp = surroundGeom.getAttribute("position")!;
  const cols = new Float32Array(sp.count * 3);
  for (let vi = 0; vi < sp.count; vi++) {
    const dx = sp.getX(vi) / 9.5, dz = (sp.getZ(vi) + 0.5) / 8;
    const r = Math.sqrt(dx * dx + dz * dz);
    const f = 0.12 + 0.88 * Math.pow(Math.max(0, 1 - r / 1.6), 1.6);
    cols[vi * 3] = f; cols[vi * 3 + 1] = f * 0.97; cols[vi * 3 + 2] = f * 0.92;
  }
  surroundGeom.setAttribute("color", new BufferAttribute(cols, 3));
  const surround = new Mesh(surroundGeom, surroundMat);
  surround.position.set(0, -0.33, 1);
  surround.receiveShadow = true;
  grp.add(surround);

  // Slate desk slab.
  const desk = new Mesh(new BoxGeometry(11.4, 0.3, 9.6), envMat(theme.desk, 0.85, 0.05, 0.35, "slate", [3, 2.5]));
  desk.position.y = -0.16;
  desk.receiveShadow = true;
  desk.castShadow = true;
  grp.add(desk);

  // Brass trim strips framing the play area.
  const trimMat = envMat(theme.deskTrim, 0.3, 0.9, 1.1);
  const trimH = new BoxGeometry(10.6, 0.045, 0.09), trimV = new BoxGeometry(0.09, 0.045, 8.4);
  for (const [x, z, g] of [[0, -4.05, trimH], [0, 3.75, trimH], [-5.25, -0.15, trimV], [5.25, -0.15, trimV]] as const) {
    const m = new Mesh(g, trimMat);
    m.position.set(x, 0.012, z);
    m.castShadow = true;
    grp.add(m);
  }

  // Cloth inlay under the columns.
  const cloth = new Mesh(new BoxGeometry(9.9, 0.02, 6.2), envMat(theme.cloth, 0.95, 0, 0.12, "felt", [3, 2]));
  cloth.position.set(0, 0.002, 0.6);
  cloth.receiveShadow = true;
  grp.add(cloth);

  // Slot recesses: 4 cells + 4 foundations + 8 column guides.
  const slotMat = envMat(theme.slot, 0.9, 0.1, 0.3);
  const slotFrameMat = envMat(theme.deskTrim, 0.38, 0.85, 1.0);
  const slotGeom = new BoxGeometry(LAYOUT.cardW + 0.1, 0.014, LAYOUT.cardH + 0.1);
  const frameGeom = new BoxGeometry(LAYOUT.cardW + 0.18, 0.01, LAYOUT.cardH + 0.18);
  const addSlot = (x: number, z: number, loc: Loc): void => {
    const frame = new Mesh(frameGeom, slotFrameMat);
    frame.position.set(x, 0.004, z);
    const inner = new Mesh(slotGeom, slotMat);
    inner.position.set(x, 0.012, z);
    inner.receiveShadow = true;
    grp.add(frame, inner);
    slotMeshes.push({ mesh: inner, loc });
  };
  for (let i = 0; i < 4; i++) {
    addSlot(slotX(i, false), LAYOUT.topRowZ, { zone: "cell", index: i });
    addSlot(slotX(i, true), LAYOUT.topRowZ, { zone: "foundation", index: i });
  }
  for (let c = 0; c < 8; c++) {
    const guide = new Mesh(slotGeom, slotMat);
    guide.position.set(columnX(c), 0.008, LAYOUT.colTopZ);
    guide.receiveShadow = true;
    grp.add(guide);
    slotMeshes.push({ mesh: guide, loc: { zone: "tableau", index: c } });
  }
}

// ---------------------------------------------------------------- cards
interface CardEntry { mesh: Mesh<Material[]>; loc: Loc | null; depth: number; face: AnyMat }
const cardMeshes = new Map<number, CardEntry>();
let cardGeos = new Map<number, BufferGeometry>();
let sideMat: AnyMat | null = null;
const CELL = { cols: 13, rows: 4 };
/** The card's rounded-rectangle outline extruded (render.js cardGeometry), its caps mapped once across the card's atlas cell. */
function cardGeometry(cardId: number, curve: number): BufferGeometry {
  const w = LAYOUT.cardW, h = LAYOUT.cardH, r = 0.07;
  const s = new Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const col = cardId % 13, row = Math.floor(cardId / 13);
  const inset = 0.004;
  const uv = (px: number, py: number): Vector2 => {
    const u = Math.min(1, Math.max(0, (px + w / 2) / w)), v = Math.min(1, Math.max(0, (py + h / 2) / h));
    return new Vector2((col + inset + u * (1 - 2 * inset)) / CELL.cols, 1 - (row + inset + (1 - v) * (1 - 2 * inset)) / CELL.rows);
  };
  const geom = new ExtrudeGeometry(s, {
    depth: LAYOUT.cardD, curveSegments: curve, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1,
    UVGenerator: {
      generateTopUV: (_g, v, a, b, c) => [a, b, c].map((i) => uv(v[i * 3]!, v[i * 3 + 1]!)),
      generateSideWallUV: () => [new Vector2(), new Vector2(), new Vector2(), new Vector2()],
    },
  });
  geom.rotateX(-Math.PI / 2);
  return geom;
}
function faceAtlas(): Texture {
  const detail = look!.detailed ? "detailed" : "plain";
  const pal = palette === "standard" ? "" : `-${palette}`;
  return image(`assets/textures/faces-${theme.id}${pal}-${detail}.webp`, 0, 0, look!.detailed ? 8 : 4);
}
/** render.js makeFaceMat: Lambert on Low; a lightly clear-coated physical face with Reflections on High/Ultra; else standard. */
function makeFaceMat(): AnyMat {
  const map = faceAtlas();
  if (look!.budget.material === "lambert") return new MeshLambertMaterial({ map });
  if (look!.reflections && look!.budget.material === "physical") {
    return new MeshPhysicalMaterial({ map, roughness: 0.52, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.42, envMapIntensity: 0.35 });
  }
  return new MeshStandardMaterial({ map, roughness: 0.55, metalness: 0.02 });
}
function makeSideMat(): AnyMat {
  return look!.budget.material === "lambert"
    ? new MeshLambertMaterial({ color: new Color(0xd8d2c2) })
    : new MeshStandardMaterial({ color: new Color(0xd8d2c2), roughness: 0.6, metalness: 0, envMapIntensity: 0.3 });
}
/** Rebuilds every card's geometry and materials for the look and theme (positions kept). */
function rebuildCards(): void {
  for (const g of cardGeos.values()) g.dispose();
  cardGeos = new Map();
  sideMat?.dispose();
  sideMat = makeSideMat();
  for (const [id, e] of cardMeshes) {
    e.face.dispose();
    e.face = makeFaceMat();
    e.mesh.geometry = geoFor(id);
    e.mesh.material = [e.face, sideMat];
    e.mesh.castShadow = look!.shadows > 0;
  }
}
function geoFor(id: number): BufferGeometry {
  let g = cardGeos.get(id);
  if (!g) { g = cardGeometry(id, look!.budget.curve); cardGeos.set(id, g); }
  return g;
}
function makeCard(id: number): CardEntry {
  const face = makeFaceMat();
  const mesh = new Mesh(geoFor(id), [face, sideMat!]);
  mesh.castShadow = look!.shadows > 0;
  mesh.receiveShadow = true;
  mesh.userData.cardId = id;
  scene.add(mesh);
  return { mesh, loc: null, depth: 0, face };
}

// ---------------------------------------------------------------- tweens (authored duration and easing, interruptible)
interface Tween { duration: number; elapsed: number; tag: string; update(k: number): void; done?(cancelled: boolean): void }
let tweens: Tween[] = [];
const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
function addTween(t: Omit<Tween, "elapsed">): void { tweens.push({ ...t, elapsed: 0 }); }
function cancelTag(tag: string): void {
  tweens = tweens.filter((t) => { if (t.tag === tag) { t.done?.(true); return false; } return true; });
}
/** Settle: every animation to its exact end state. */
export function settle(): void {
  const list = tweens;
  tweens = [];
  for (const t of list) { t.update(1); t.done?.(false); }
}
export function isAnimating(): boolean { return tweens.length > 0; }
function updateTweens(dt: number): void {
  for (const t of tweens.slice()) {
    if (!tweens.includes(t)) continue; // cancelled by an earlier tween's callback
    t.elapsed += dt;
    const k = Math.min(1, t.elapsed / t.duration);
    t.update(easeInOut(k));
    if (k >= 1) { tweens = tweens.filter((x) => x !== t); t.done?.(false); }
  }
}

// ---------------------------------------------------------------- sync
const animating = new Set<number>();
let selectedIds = new Set<number>();
let selectedLoc: Loc | null = null;
function locateCards(s: State): Map<number, { loc: Loc; depth: number }> {
  const map = new Map<number, { loc: Loc; depth: number }>();
  s.cells.forEach((id, i) => { if (id !== null) map.set(id, { loc: { zone: "cell", index: i }, depth: 0 }); });
  s.foundations.forEach((f, i) => f.forEach((id, d) => map.set(id, { loc: { zone: "foundation", index: i }, depth: d })));
  s.tableau.forEach((col, i) => col.forEach((id, d) => map.set(id, { loc: { zone: "tableau", index: i }, depth: d })));
  return map;
}
/** render.js syncState: meshes follow a new immutable snapshot; moves animate unless instant (or reduced motion). */
export function syncState(next: State, instant: boolean): void {
  const prevMap = state ? locateCards(state) : new Map<number, { loc: Loc; depth: number }>();
  const nextMap = locateCards(next);
  state = next;
  if (!look) return;
  const inst = reducedMotion || instant;
  for (const [cardId, dst] of nextMap) {
    let entry = cardMeshes.get(cardId);
    if (!entry) { entry = makeCard(cardId); cardMeshes.set(cardId, entry); entry.mesh.position.set(0, 0, 0); }
    const prev = prevMap.get(cardId);
    const target = restPos(dst.loc, dst.depth);
    entry.loc = dst.loc;
    entry.depth = dst.depth;
    const moved = !prev || prev.loc.zone !== dst.loc.zone || prev.loc.index !== dst.loc.index || prev.depth !== dst.depth;
    const mesh = entry.mesh;
    if (moved) {
      const from = { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z };
      if (inst || (from.x === 0 && from.y === 0 && from.z === 0)) {
        cancelTag(`card-${cardId}`);
        mesh.position.set(target.x, target.y, target.z);
      } else {
        const lift = 0.5 + Math.abs(target.x - from.x) * 0.06;
        animating.add(cardId);
        cancelTag(`card-${cardId}`);
        addTween({
          duration: 0.24 + Math.min(0.18, Math.abs(target.x - from.x) * 0.03),
          tag: `card-${cardId}`,
          update: (k) => {
            mesh.position.x = from.x + (target.x - from.x) * k;
            mesh.position.z = from.z + (target.z - from.z) * k;
            mesh.position.y = from.y + (target.y - from.y) * k + Math.sin(k * Math.PI) * lift;
          },
          done: () => { animating.delete(cardId); mesh.position.set(target.x, target.y, target.z); },
        });
      }
    } else if (!selectedIds.has(cardId) && !animating.has(cardId)) {
      mesh.position.set(target.x, target.y, target.z);
    }
    mesh.renderOrder = dst.depth;
  }
  applySelectionLift();
}
/** Removes the table's cards (back to the title). */
export function clearCards(): void {
  settle();
  for (const e of cardMeshes.values()) { scene.remove(e.mesh); e.face.dispose(); }
  cardMeshes.clear();
  state = null;
  setSelection(null, []);
  setLegalTargets([]);
}

// ---------------------------------------------------------------- selection, targets
function applySelectionLift(): void {
  const accent = new Color(theme.accent);
  for (const [cardId, e] of cardMeshes) {
    if (!e.loc || animating.has(cardId)) continue;
    const base = restPos(e.loc, e.depth);
    const dragged = drag?.ids.has(cardId) && drag.moved;
    const face = e.face as MeshStandardMaterial;
    if (selectedIds.has(cardId)) {
      if (!dragged) e.mesh.position.y = base.y + LAYOUT.liftY;
      face.emissive = accent;
      face.emissiveIntensity = 0.22;
    } else {
      if (!dragged) e.mesh.position.y = base.y;
      face.emissiveIntensity = 0;
    }
  }
}
const ringGeom = new RingGeometry(0.52, 0.62, 40);
ringGeom.rotateX(-Math.PI / 2);
let selectionRing: Mesh | null = null;
const targetRings: Mesh[] = [];
/** With bloom on, markers render above 1.0 (not tone-mapped) so only they and the sparks glow (render.js tuneMarker). */
function tuneMarker(m: MeshBasicMaterial): void {
  const glow = !!look?.bloom;
  m.color.set(theme.accent);
  if (glow) m.color.multiplyScalar(1.7);
  m.toneMapped = !glow;
}
function ensureRing(): Mesh {
  if (!selectionRing) {
    const mat = new MeshBasicMaterial({ color: new Color(theme.accent), transparent: true, opacity: 0.85, side: DoubleSide });
    tuneMarker(mat);
    selectionRing = new Mesh(ringGeom, mat);
    selectionRing.visible = false;
    selectionRing.renderOrder = 5;
    scene.add(selectionRing);
  }
  return selectionRing;
}
export function setLegalTargets(locs: Loc[]): void {
  while (targetRings.length < locs.length) {
    const mat = new MeshBasicMaterial({ color: new Color(theme.accent), transparent: true, opacity: 0.4, side: DoubleSide });
    tuneMarker(mat);
    const m = new Mesh(ringGeom, mat);
    m.renderOrder = 4;
    scene.add(m);
    targetRings.push(m);
  }
  targetRings.forEach((m, i) => {
    const l = locs[i];
    if (l) {
      const p = locToWorld(l, l.zone === "tableau" && state ? state.tableau[l.index]!.length : 0);
      m.position.set(p.x, 0.03, p.z);
      m.visible = true;
    } else m.visible = false;
  });
}
/** The selected location (its ring) and the lifted, glowing cards. */
export function setSelection(loc: Loc | null, cardIds: number[]): void {
  selectedLoc = loc;
  selectedIds = new Set(cardIds);
  const ring = ensureRing();
  if (!loc) ring.visible = false;
  else {
    const depth = loc.zone === "tableau" && state ? Math.max(0, state.tableau[loc.index]!.length - 1) : 0;
    const p = locToWorld(loc, depth);
    ring.position.set(p.x, 0.035, p.z);
    ring.visible = true;
  }
  applySelectionLift();
}

// ---------------------------------------------------------------- particles (bounded pool, cosmetic only)
interface Pool { pts: Points; pos: Float32Array; vel: Float32Array; life: Float32Array; cap: number; active: boolean }
let pool: Pool | null = null;
function particleLook(): void {
  if (!pool || !look) return;
  const hi = look.particles === "high";
  const m = pool.pts.material as PointsMaterial;
  m.map = hi ? spriteTex : null;
  m.blending = hi ? AdditiveBlending : NormalBlending;
  m.size = hi ? 0.13 : 0.06;
  m.color.set(theme.accent);
  const glow = hi && look.bloom;
  if (glow) m.color.multiplyScalar(1.8);
  m.toneMapped = !glow;
  pool.cap = sparkCap(look);
  for (let i = pool.cap; i < SPARK_MAX; i++) { pool.life[i] = 0; pool.pos[i * 3 + 1] = -50; }
}
function ensureParticles(): Pool {
  if (!pool) {
    const pos = new Float32Array(SPARK_MAX * 3);
    for (let i = 0; i < SPARK_MAX; i++) pos[i * 3 + 1] = -50;
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(pos, 3));
    const pts = new Points(geom, new PointsMaterial({ color: new Color(theme.accent), size: 0.06, transparent: true, opacity: 0.9, depthWrite: false }));
    pts.visible = false;
    pts.frustumCulled = false;
    scene.add(pts);
    pool = { pts, pos, vel: new Float32Array(SPARK_MAX * 3), life: new Float32Array(SPARK_MAX), cap: 0, active: false };
    particleLook();
  }
  return pool;
}
function burst(x: number, y: number, z: number, count: number): void {
  if (reducedMotion || !look || look.particles === "off") return;
  const p = ensureParticles();
  // Burst sizes are authored for a 400-spark pool; the budget scales them.
  count = Math.max(1, Math.round((count * p.cap) / 400));
  let start = 0;
  while (start < p.cap && p.life[start]! > 0) start++;
  const n = Math.min(count, p.cap - start);
  for (let j = 0; j < n; j++) {
    const i = start + j;
    p.pos[i * 3] = x; p.pos[i * 3 + 1] = y; p.pos[i * 3 + 2] = z;
    const a = (j / n) * Math.PI * 2;
    const r = 0.8 + ((j * 7919) % 100) / 250;
    p.vel[i * 3] = Math.cos(a) * r;
    p.vel[i * 3 + 1] = 1.6 + ((j * 104729) % 100) / 120;
    p.vel[i * 3 + 2] = Math.sin(a) * r;
    p.life[i] = 1;
  }
  p.pts.geometry.getAttribute("position")!.needsUpdate = true;
  p.pts.visible = true;
  p.active = true;
}
function updateParticles(dt: number): void {
  const p = pool;
  if (!p || !p.active) return;
  let any = false;
  for (let i = 0; i < p.cap; i++) {
    if (p.life[i]! <= 0) { p.pos[i * 3 + 1] = -50; continue; }
    any = true;
    p.life[i]! -= dt * 1.4;
    p.vel[i * 3 + 1]! -= dt * 3.2;
    p.pos[i * 3]! += p.vel[i * 3]! * dt;
    p.pos[i * 3 + 1] = Math.max(0.02, p.pos[i * 3 + 1]! + p.vel[i * 3 + 1]! * dt);
    p.pos[i * 3 + 2]! += p.vel[i * 3 + 2]! * dt;
    if (p.life[i]! <= 0) p.pos[i * 3 + 1] = -50;
  }
  p.pts.geometry.getAttribute("position")!.needsUpdate = true;
  if (!any) { p.active = false; p.pts.visible = false; }
}
// Ambient motion: dust motes drifting slowly through the lamp light; the lamp breathes very slightly.
let motes: { pts: Points; pos: Float32Array; seed: Float32Array; t: number } | null = null;
function ensureMotes(): void {
  if (motes) return;
  const pos = new Float32Array(MOTE_MAX * 3), seed = new Float32Array(MOTE_MAX);
  for (let i = 0; i < MOTE_MAX; i++) {
    let h = Math.sin(i * 12.9898) * 43758.5453; h -= Math.floor(h);
    let h2 = Math.sin(i * 78.233) * 12543.123; h2 -= Math.floor(h2);
    let h3 = Math.sin(i * 39.425) * 24634.634; h3 -= Math.floor(h3);
    pos[i * 3] = (h - 0.5) * 11; pos[i * 3 + 1] = 0.6 + h2 * 3.4; pos[i * 3 + 2] = (h3 - 0.5) * 9;
    seed[i] = h * 100;
  }
  const geom = new BufferGeometry();
  geom.setAttribute("position", new BufferAttribute(pos, 3));
  const pts = new Points(geom, new PointsMaterial({
    color: new Color(0xffe2b0), size: 0.05, map: spriteTex, transparent: true, opacity: 0.35, depthWrite: false, blending: AdditiveBlending,
  }));
  pts.frustumCulled = false;
  scene.add(pts);
  motes = { pts, pos, seed, t: 0 };
}
function updateMotes(dt: number): void {
  const on = !!look?.ambient && !reducedMotion;
  if (on) ensureMotes();
  if (!motes) return;
  motes.pts.visible = on;
  if (!on) { key.intensity = 1.35 * LEGACY; return; }
  const live = Math.min(MOTE_MAX, look!.budget.motes);
  motes.pts.geometry.setDrawRange(0, live);
  motes.t += dt;
  const p = motes.pos;
  for (let i = 0; i < live; i++) {
    const sd = motes.seed[i]!;
    p[i * 3]! += Math.sin(motes.t * 0.23 + sd) * dt * 0.08;
    p[i * 3 + 1]! += (Math.sin(motes.t * 0.17 + sd * 1.7) * 0.05 + 0.02) * dt;
    p[i * 3 + 2]! += Math.cos(motes.t * 0.19 + sd) * dt * 0.06;
    if (p[i * 3 + 1]! > 4.2) p[i * 3 + 1] = 0.5;
  }
  motes.pts.geometry.getAttribute("position")!.needsUpdate = true;
  key.intensity = 1.35 * LEGACY * (1 + Math.sin(motes.t * 0.6) * 0.015);
}

// ---------------------------------------------------------------- camera
export interface ViewRect { x: number; y: number; width: number; height: number }
let view: ViewRect = { x: 0, y: 0, width: 1, height: 1 };
let win = { w: 1, h: 1 };
let frameKey = "";
let shake: { base: Vector3 } | null = null;
/** render.js fitCamera: fit the 10.6-wide board and its depth into the playfield's aspect. */
function fitCamera(): void {
  const aspect = view.width / Math.max(1, view.height);
  const tan = Math.tan((CAMERA.fov * Math.PI) / 360);
  const vFit = 8.8 / (2 * tan);
  const hFit = 10.7 / (2 * tan * aspect);
  const t = Math.max(vFit, hFit) / CAMERA.dist;
  camera.position.set(0, CAMERA.height * t, CAMERA.back * t);
  camera.lookAt(0, 0, CAMERA.lookZ);
  camera.aspect = aspect;
  // The canvas sat between the top bar, rails and tray: the window is the playfield's view, offset.
  camera.setViewOffset(view.width, view.height, -view.x, -view.y, win.w, win.h);
  camera.updateProjectionMatrix();
  if (scene.fog instanceof Fog) {
    const d = camera.position.length();
    scene.fog.near = d * 1.25;
    scene.fog.far = d * 2.6;
  }
  shake = null;
}
/** The camera reset key: the framing again. */
export function resetCamera(): void { frameKey = ""; }
/** render.js nudge: a low, short camera shake (reduced-motion aware). */
function nudge(strength: number): void {
  if (reducedMotion) return;
  const base = shake?.base ?? camera.position.clone();
  shake = { base };
  cancelTag("shake");
  addTween({
    duration: 0.22, tag: "shake",
    update: (k) => {
      const amp = (1 - k) * 0.05 * strength;
      camera.position.x = base.x + Math.sin(k * 31) * amp;
      camera.position.z = base.z + Math.cos(k * 27) * amp * 0.6;
    },
    done: () => { camera.position.copy(base); shake = null; },
  });
}

/** render.js playEvent: foundation sparks, the win bursts and nudge, the invalid nudge. */
export function playEvent(event: "foundation" | "win" | "invalid", loc?: Loc): void {
  if (event === "foundation" && loc) {
    const p = locToWorld(loc, 0);
    burst(p.x, 0.3, p.z, 40);
  } else if (event === "win") {
    for (let i = 0; i < 4; i++) {
      const fp = locToWorld({ zone: "foundation", index: i }, 0);
      burst(fp.x, 0.4, fp.z, 100);
    }
    nudge(1.5);
  } else if (event === "invalid") nudge(0.6);
}

// ---------------------------------------------------------------- picking and dragging
export type Hit = { kind: "card"; cardId: number } | { kind: "slot"; loc: Loc };
/** Window pixels → the topmost card (cards first) or the slot under them (render.js pick). */
export function pick(x: number, y: number, exclude?: Set<number>): Hit | null {
  if (!renderer.camera) return null;
  raycaster.setFromCamera(pointerToNdc(x, y), camera);
  const meshes: Object3D[] = [];
  for (const e of cardMeshes.values()) if (!exclude || !exclude.has(e.mesh.userData.cardId as number)) meshes.push(e.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length) {
    hits.sort((a, b) => (b.object.position.y - a.object.position.y) || (a.distance - b.distance));
    return { kind: "card", cardId: hits[0]!.object.userData.cardId as number };
  }
  const slotHits = raycaster.intersectObjects(slotMeshes.map((s) => s.mesh), false);
  if (slotHits.length) {
    const s = slotMeshes.find((m) => m.mesh === slotHits[0]!.object);
    if (s) return { kind: "slot", loc: s.loc };
  }
  return null;
}
const dragPlane = new Plane(new Vector3(0, 1, 0), -0.3);
function planePoint(x: number, y: number): Vector3 {
  raycaster.setFromCamera(pointerToNdc(x, y), camera);
  const out = new Vector3();
  raycaster.ray.intersectPlane(dragPlane, out);
  return out;
}
export function cardLocOf(cardId: number): Loc | null { return cardMeshes.get(cardId)?.loc ?? null; }
interface Drag { cardId: number; ids: Set<number>; depth0: number; moved: boolean }
let drag: Drag | null = null;
/** A press on a card: the run it lifts (a buried card: the column's movable top card; render.js onPointerDown). */
export function beginDrag(cardId: number): void {
  const e = cardMeshes.get(cardId);
  let ids = new Set([cardId]);
  let depth0 = e ? e.depth : 0;
  if (e && e.loc && e.loc.zone === "tableau" && state) {
    const col = state.tableau[e.loc.index]!;
    const runStart = col.length - Rules.orderedRunLength(col);
    if (depth0 >= runStart) { for (let d = depth0; d < col.length; d++) ids.add(col[d]!); }
    else { ids = new Set([col[col.length - 1]!]); depth0 = col.length - 1; }
  }
  drag = { cardId, ids, depth0, moved: false };
}
/** The pointer moved past the tap distance: the run follows it over the desk. */
export function dragTo(x: number, y: number): void {
  if (!drag) return;
  drag.moved = true;
  const p = planePoint(x, y);
  for (const [id, e] of cardMeshes) {
    if (!drag.ids.has(id)) continue;
    cancelTag(`card-${id}`);
    animating.delete(id);
    e.mesh.position.set(p.x, 0.4, p.z + (e.depth - drag.depth0) * LAYOUT.stackDY);
  }
}
/** The press ended: the dragged ids (for the drop pick), and the cards back on the table if nothing moves them. */
export function endDrag(): { cardId: number; ids: Set<number>; moved: boolean } | null {
  const d = drag;
  drag = null;
  return d;
}
export function dragging(): boolean { return !!drag?.moved; }
/** Puts every card back at rest (a cancelled or refused drop). */
export function restore(): void { if (state) syncState(state, true); }

/** A world point's window pixels. */
function toScreen(x: number, y: number, z: number): { x: number; y: number } {
  const v = new Vector3(x, y, z).project(camera);
  return { x: ((v.x + 1) / 2) * win.w, y: ((1 - v.y) / 2) * win.h };
}
/** The window rectangle of a location's pickable part: a stacked card's uncovered strip, the top card or a slot. */
export function screenRect(loc: Loc, depth: number, covered: boolean): ViewRect | null {
  if (!renderer.camera) return null;
  const p = restPos(loc, depth);
  const hw = LAYOUT.cardW / 2, hh = LAYOUT.cardH / 2;
  const z0 = p.z - hh, z1 = covered ? p.z - hh + LAYOUT.stackDY : p.z + hh;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [dx, dz] of [[-hw, z0], [hw, z0], [hw, z1], [-hw, z1]] as const) {
    const s = toScreen(p.x + dx, p.y + LAYOUT.cardD, dz);
    x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// ---------------------------------------------------------------- the look
function applyReflections(): void {
  const env = look!.reflections ? envMap() : null;
  scene.traverse((o) => {
    const m = (o as Mesh).material;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) if (x instanceof MeshStandardMaterial) x.envMap = env;
  });
  hemi.intensity = (env ? 0.32 : 0.55) * LEGACY;
  fill.intensity = (env ? 0.18 : 0.25) * LEGACY;
}
function rebuild(): void {
  buildEnvironment();
  rebuildCards();
  if (selectionRing) tuneMarker(selectionRing.material as MeshBasicMaterial);
  for (const r of targetRings) tuneMarker(r.material as MeshBasicMaterial);
  particleLook();
  if (state) syncState(state, true);
  setSelection(selectedLoc, [...selectedIds]);
  applyReflections();
}
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  // UnrealBloomPass(0.6, 0.45, threshold 0.9 on the tone-mapped image): the runtime blooms before tone mapping,
  // where ACES at 1.05 reaches 0.9 from about 1.8 — so only the untone-mapped markers and sparks bloom.
  // The page's three r152 UnrealBloomPass(0.6, 0.45, 1.8), drawn by the r160 bloom model (r169 and older) at its strength.
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.6, radius: 0.45, threshold: 1.8, resolution: next.budget.bloomRes } : null;
  // GradeShader: 0.18 S-curve, +7 % saturation, cool shadows / warm highlights (smoothstep 0.05–0.6), vignette 0.24.
  renderer.grade = next.grade ? {
    space: "linear", contrast: 0.18, saturation: 1.07, split: [0.05, 0.6], shadows: [0.97, 0.99, 1.04], highlights: [1.03, 1.0, 0.96],
    vignette: { amount: 0.24, inner: 0.3, outer: 0.8, scale: [1, 0.85] },
    levels: [0.985, 0.004], // s * 0.985 + 0.004
    overRange: "keep", // minor 29: mix(c, s + max(c - 1, 0), amount) as the page's grade
  } : null;
  renderer.antialias = next.antialias;
  renderer.shadowMap.enabled = next.shadows > 0;
  key.castShadow = next.shadows > 0;
  if (next.shadows > 0) key.shadow.mapSize = next.shadows;
  rebuild();
}
/** The deal's theme (content.js THEMES: the player's or the stage's). */
export function setTheme(id: string | undefined): void {
  const t = Content.THEMES.find((x) => x.id === id) ?? Content.THEMES[0]!;
  if (t === theme && envGroup) return;
  theme = t;
  if (look) rebuild();
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; }
/** The suit colour palette of the card faces (Settings › Suit color palette). */
export function setPalette(p: string): void {
  if (p === palette) return;
  palette = p;
  if (look) rebuildCards();
  applySelectionLift();
  if (look) applyReflections();
}
/** Whether the desk draws (the title and results show their key art over it). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

// ---------------------------------------------------------------- per frame
/** Each frame: the framing for the window and the playfield (window px), tweens, sparks and motes. */
export function update(dt: number, w: number, h: number, rect: ViewRect): void {
  const fk = `${w}x${h}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
  if (w > 0 && h > 0 && rect.width > 0 && rect.height > 0 && fk !== frameKey) {
    frameKey = fk;
    win = { w, h };
    view = { ...rect };
    if (shake) { cancelTag("shake"); }
    fitCamera();
  }
  dt = Math.min(0.05, dt);
  updateTweens(dt);
  updateParticles(dt);
  updateMotes(dt);
}
/** For the browser check: the window point of a card's strip or a slot. */
export function hitPoint(loc: Loc, depth: number, covered: boolean): { x: number; y: number } | null {
  const r = screenRect(loc, depth, covered);
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
}
