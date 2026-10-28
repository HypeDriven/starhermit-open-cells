// The look of the top bar, rails, tray and screens: the browser build's
// css/style.css, rewritten class-based in tools/ui-style.css and converted
// once with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (scroll bars,
// focus rings, selects, check boxes) take. The table theme (html[data-theme]:
// Brass & Slate, Verdigris, Night Ink, Parchment, High Contrast), the
// runtime's high-contrast option (html.high-contrast) and the suit colour
// palettes (html[data-palette]) are token sets; the colour-mix() shades the
// sheet used are recomputed from them here.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  desk: "#2b3138", trim: "#b08d3e", ink: "#e8e2d2", "ink-dim": "#b9b2a0", panel: "#22282e", "panel-2": "#1b2025",
  accent: "#d8b04c", "card-face": "#f4efe4", "card-red": "#a63a3a", "card-black": "#26282e", danger: "#c05a4a",
};
/** style.css html[data-theme="…"]. */
const THEMES: Record<string, Tokens> = {
  "brass-slate": {},
  verdigris: { desk: "#25332f", trim: "#7ba88f", panel: "#1f2b27", "panel-2": "#18211e", accent: "#9fc7ae", ink: "#e2ecdf", "ink-dim": "#a8b8ac", "card-face": "#f0f2e8", "card-red": "#b0483e", "card-black": "#22302b" },
  "night-ink": { desk: "#1c2030", trim: "#6d7bb0", panel: "#181c2a", "panel-2": "#12151f", accent: "#8fa2e0", ink: "#dfe2f0", "ink-dim": "#9aa1c0", "card-face": "#e8e9f2", "card-red": "#c05a6e", "card-black": "#20263c" },
  parchment: { desk: "#6b5b41", trim: "#8a734f", panel: "#57492f", "panel-2": "#463a25", accent: "#f0d493", ink: "#f5ecd7", "ink-dim": "#c9bb9a", "card-face": "#faf5e6", "card-red": "#9c3b30", "card-black": "#33291c" },
};
/** html[data-theme="contrast"], html.high-contrast. */
const CONTRAST: Tokens = {
  desk: "#000000", trim: "#ffffff", panel: "#0a0a0a", "panel-2": "#000000", accent: "#ffdd00",
  ink: "#ffffff", "ink-dim": "#e0e0e0", "card-face": "#ffffff", "card-red": "#ff5a00", "card-black": "#000000",
};
/** html[data-palette="…"]. */
const PALETTES: Record<string, Tokens> = {
  standard: {},
  deuteranopia: { "card-red": "#b0660a", "card-black": "#2050a0" },
  tritanopia: { "card-red": "#c03040", "card-black": "#2060b0" },
};

const hex = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (v: number[]): string => `#${v.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;
/** color-mix(in srgb, a p, b). */
function mix(a: string, p: number, b: string): string {
  const x = hex(a), y = hex(b);
  return toHex(x.map((v, i) => v * p + y[i]! * (1 - p)));
}
const alpha = (c: string, a: number): string => c + Math.round(a * 255).toString(16).padStart(2, "0");

let current: Tokens = { ...BASE };
/** The tokens for a theme, contrast and palette, with the sheet's derived shades. */
export function tokensFor(theme: string, highContrast: boolean, palette: string): Tokens {
  const t: Tokens = { ...BASE, ...(theme === "contrast" || highContrast ? CONTRAST : THEMES[theme] ?? {}), ...(PALETTES[palette] ?? {}) };
  t.focus = t.accent!;
  for (const p of [25, 30, 40, 45, 60]) t[`trim-${p}`] = alpha(t.trim!, p / 100);
  t.hover = mix(t.panel!, 0.7, t.trim!);
  t.done = mix(t.trim!, 0.22, t["panel-2"]!);
  t.lesson = mix(t.accent!, 0.14, t["panel-2"]!);
  return t;
}

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 11, radius: 8,
    text: "#e8e2d2", muted: "#b9b2a0", panel: "#22282e", control: "#1b2025", hovered: "#3f3c36",
    pressed: "#1b2025", field: "#1b2025", accent: "#d8b04c", focus: "#d8b04c", outline: "#b08d3e",
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$ink-dim", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$ink" }, radius: 6, padding: 6 },
    // .screen-overlay: the screen over a dim of the page behind it.
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#0a0c0eb8" } } },
  });
}

let key = "";
/** Applies the theme / contrast / palette tokens (cheap when unchanged). */
export function applyTokens(theme: string, highContrast: boolean, palette: string): void {
  const k = `${theme}:${highContrast}:${palette}`;
  if (k === key) return;
  key = k;
  current = tokensFor(theme, highContrast, palette);
  ui.setTokens(current);
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
