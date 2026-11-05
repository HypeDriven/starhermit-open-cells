// The look per graphics level. The engine's level table owns the engine effects
// (levelSettings(): shadows and their map size, bloom, grade, anti-aliasing, the
// texture cap); the browser build's four presets (src/gfx.js TABLE / BUDGETS) keep
// the game-only art, keyed by the quality tier: materials, textures, card curves,
// reflections, ambient motion. The spark pool and the dust motes scale with the
// level's particle budget against the tier's anchor level, at most 2×. The runtime
// owns the rest of what the old Graphics panel did: Auto and the level choice,
// render scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit
// and readout. The old panel's per-effect overrides are not offered (the runtime's
// Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Desk and card shading: Lambert (Low), Standard (Balanced), clear-coated Physical card faces with Reflections (High/Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Wood texture size in px (slate and felt: half; Surface detail Detailed). */
  texture: 256 | 512 | 1024;
  /** Fine bump map on the slate and felt. */
  surfBump: boolean;
  /** Card corner segments. */
  curve: number;
  /** Lamp-pool grid of the walnut surround (vertex colours), columns × rows. */
  pool: [number, number];
  /** Spark pool at Particles High (Low: half). */
  sparks: number;
  /** Dust motes in the lamp light (Ambient motion On). */
  motes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  reflections: boolean;
  /** Surface detail Detailed: textured slate, felt and wood, linen card faces. */
  detailed: boolean;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  particles: "off" | "low" | "high";
  ambient: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "detailed" | "particles" | "ambient">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, detailed: false, particles: "off", ambient: false },
  balanced: { reflections: true, detailed: true, particles: "low", ambient: false },
  high: { reflections: true, detailed: true, particles: "high", ambient: true },
  ultra: { reflections: true, detailed: true, particles: "high", ambient: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 256, surfBump: false, curve: 3, pool: [24, 20], sparks: 120, motes: 30 },
  balanced: { material: "standard", texture: 256, surfBump: false, curve: 4, pool: [36, 30], sparks: 200, motes: 40 },
  high: { material: "physical", texture: 512, surfBump: true, curve: 8, pool: [60, 50], sparks: 400, motes: 70 },
  ultra: { material: "physical", texture: 1024, surfBump: true, curve: 12, pool: [60, 50], sparks: 600, motes: 120 },
};
export const SPARK_MAX = 1200, MOTE_MAX = 240;
/** Each tier's anchor level: its budgets are written for it. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a level's settings. Plain data: render.applyLook compares it as JSON. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = BUDGETS[preset];
  // The level's particle budget against the anchor's: more sparks and motes above the anchor, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, texture: Math.min(b.texture, s.maxTextureSize) as Budget["texture"],
      sparks: Math.min(SPARK_MAX, Math.round(b.sparks * k)), motes: Math.min(MOTE_MAX, Math.round(b.motes * k)) },
  };
}
/** Live spark-pool size (Particles Low: half the budget; gfx.js sparkCap). */
export function sparkCap(l: Look): number {
  return l.particles === "high" ? l.budget.sparks : l.particles === "low" ? Math.round(l.budget.sparks / 2) : 0;
}
