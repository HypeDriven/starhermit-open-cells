// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the spark pool and the dust motes scaled within the tier by the level
// (frame().levelIndex, at most 2×), as the browser build scaled them by its
// hardware level. The runtime owns the rest of what the old Graphics panel
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old panel's
// per-effect overrides are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  reflections: boolean;
  /** Surface detail Detailed: textured slate, felt and wood, linen card faces. */
  detailed: boolean;
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  particles: "off" | "low" | "high";
  ambient: boolean;
  budget: Budget;
}

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, reflections: false, detailed: false, bloom: false, grade: false, antialias: "off", particles: "off", ambient: false },
  balanced: { shadows: 1024, reflections: true, detailed: true, bloom: false, grade: true, antialias: "fxaa", particles: "low", ambient: false },
  high: { shadows: 2048, reflections: true, detailed: true, bloom: true, grade: true, antialias: "smaa", particles: "high", ambient: true },
  ultra: { shadows: 4096, reflections: true, detailed: true, bloom: true, grade: true, antialias: "msaa", particles: "high", ambient: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 256, surfBump: false, curve: 3, pool: [24, 20], sparks: 120, motes: 30, bloomRes: 0.5 },
  balanced: { material: "standard", texture: 256, surfBump: false, curve: 4, pool: [36, 30], sparks: 200, motes: 40, bloomRes: 0.5 },
  high: { material: "physical", texture: 512, surfBump: true, curve: 8, pool: [60, 50], sparks: 400, motes: 70, bloomRes: 0.5 },
  ultra: { material: "physical", texture: 1024, surfBump: true, curve: 12, pool: [60, 50], sparks: 600, motes: 120, bloomRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const SPARK_MAX = 1200, MOTE_MAX = 240;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: budgets grow with the level above the tier's first, at most 2×.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** Live spark-pool size (Particles Low: half the budget; gfx.js sparkCap). */
export function sparkCap(l: Look): number {
  return l.particles === "high" ? l.budget.sparks : l.particles === "low" ? Math.round(l.budget.sparks / 2) : 0;
}
