// The browser build's DOM shell (index.html + src/ui.js) as starhermit:ui,
// built every frame over the desk: the top bar (brand, player and cloud-sync
// chips, the deal, Menu and Pause), the Objective / Progress rail, the
// Actions rail (Undo with its key and count, Hint, Collect, Settle, Restart,
// Concede), the compact tray (Undo, Hint, Collect, Pause; mirrored for the
// left-handed layout), the refusal toast and the account notice, the board's
// named targets (each card and slot, as the DOM board's buttons were: screen
// readers and play scripts find them) with the keyboard cursor, and every
// overlay screen (title over the key art, mode cards, Journey grid, stage /
// practice / challenge / daily / Score Chase setups, Learn, pause, Settings,
// How to play, Scores & achievements, results over the flourish, and the
// confirmations that replace window.confirm()). The old media queries are
// layouts picked by the window's logical size: wide (≥ 1024 px: both rails
// beside the table), compact portrait (the rail as a strip above the table,
// the tray below) and compact landscape (a 150 px rail and the tray). The
// desk is framed in the playfield rectangle left between them (main.ts view
// → render.ts).
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Rules, Sess, Store, type Achievement, type BoardEntry, type Constraints, type Loc, type Stage } from "./classic.ts";
import { FOUNDATION_WORDS, N, S, T, cardWords, fmtDuration, fmtTime } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  actions, app, askConcede, askRestart, closeAll, closeTop, confirmYes, dailyInfo, doAuto, doHint, doMenu, doPause, doSettle, doUndo, fresh,
  hudRects, later, leaderboardLine, leaveToTitle, lessonText, nextAfterResults, objectiveText, openScreen, resumeGame, retryDeal, rollSeed,
  startChallenge, startChase, startDaily, startJourney, startLesson, startPractice, top, view, cursorWords, type Screen,
} from "./main.ts";
import { token } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; landscape: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, landscape: lw < 1024 && lw > lh };
}
const lastSize = new Map<string, number>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; kbd?: string; pill?: string }
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 4;
/** A button `width` wide (null: its text's); a label too long for it wraps inside; `kbd` / `pill` draw the old <kbd> and count pill. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const s: ui.Style = width != null ? { width } : {};
  if (b.kbd || b.pill) {
    opts.content = () => ui.row(`${b.id}-face`, () => {
      ui.label(b.text);
      if (b.kbd) ui.column(`${b.id}-kbd`, () => ui.style("kbd-text").label(b.kbd!), { style: "kbd" });
      if (b.pill) ui.column(`${b.id}-pill`, () => ui.style("pill-text").label(b.pill!), { style: "pill" });
    }, { spacing: 6, align: "center" });
  } else if (b.name && b.name !== b.text) {
    // A face label takes the button's colour but not its weight: dark bold text on the brass buttons.
    const dark = style === "btn-primary" || style === "btn-play";
    opts.content = () => { ui.style(dark ? { text: { color: "#141414", weight: "bold" } } : {}).label(b.text); };
  } else if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 20);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) later(b.act);
}
/** Buttons at their own widths in rows that wrap at `width` (index.html .title-row). */
function flow(label: string, list: Btn[], width: number, gap = 10, justify: "start" | "center" | "end" = "center"): ui.Rect {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  return ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, bw(b) >= width ? width : null);
    }, { spacing: gap, width, justify }));
  }, { spacing: gap, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
function heading(cls: string, text: string, width: number, id?: string): void {
  if (textWidth(text, cls, "heading") <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
function rect(r: ui.Rect): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  playScreen(L);
  boardTargets();
  toasts(L);
  screens(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** A box over a window rectangle (window px) in a class, drawn as a placed role-none widget. */
function paint(id: string, x: number, y: number, w: number, h: number, cls: string): void {
  if (w <= 0 || h <= 0) return;
  const sc = ui.preferences().scale, sa = frame().safeArea;
  ui.place(id, { anchor: "top-start", x: (x - sa.left) / sc, y: (y - sa.top) / sc }, () => {
    ui.widget("", { role: "none", size: { width: w / sc, height: h / sc }, draw: (r) => draw.box(r.x, r.y, r.width, r.height, cls) });
  });
}

// ------------------------------------------------------------------ the play screen (index.html #app)
function keyOf(action: string): string {
  const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return list[0] ?? "";
}
/** The effective keys of an action, e.g. "Z" or "0/Num 0" (main.js keyText). */
export function keysFor(action: string): string {
  const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join("/") || "—";
}
function playScreen(L: Layout): void {
  const f = frame(), sc = L.sc, sa = f.safeArea;
  const s = app.session;
  const live = !app.screens.length;
  const ox = sa.left, oy = sa.top; // window px of the logical origin
  const barH = 50;
  const portrait = !L.wide && !L.landscape;

  // ---- the playfield, from the bars' sizes (the tray's and the strip's as last laid out)
  const trayH = L.wide ? 0 : lastSize.get("tray") ?? 61;
  const stripH = portrait ? lastSize.get("strip") ?? 70 : 0;
  const pad = 12, gap = 12;
  const lw = L.wide ? 240 : L.landscape ? 150 : 0, rw = L.wide ? 220 : 0;
  const rx = pad + (lw ? lw + gap : 0);
  const ry = barH + pad + (stripH ? stripH + gap : 0);
  const rwid = L.lw - rx - pad - (rw ? rw + gap : 0);
  const rhei = L.lh - ry - pad - trayH;
  view.x = ox + rx * sc; view.y = oy + ry * sc;
  view.width = Math.max(1, rwid * sc); view.height = Math.max(1, rhei * sc);
  // The desk colour around the playfield (html, body { background: var(--desk) }), under the bars and rails.
  const W = f.width, H = f.height;
  paint("desk-top", 0, 0, W, view.y, "desk");
  paint("desk-bottom", 0, view.y + view.height, W, H - view.y - view.height, "desk");
  paint("desk-left", 0, view.y, view.x, view.height, "desk");
  paint("desk-right", view.x + view.width, view.y, W - view.x - view.width, view.height, "desk");

  // ---- top bar
  const bar = ui.place("topbar", { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.row("topbar-row", () => {
      ui.style("brand").label("Open Cells");
      const name = platform.signedIn() ? platform.displayName() || T("Player") : "";
      const sync = platform.syncState();
      const syncText = sync === "saving" || sync === "syncing" ? T("saving…") : sync === "synced" ? T("cloud save ✓") : sync === "offline" ? T("sync failed") : "";
      const room = L.lw - 32 - textWidth("Open Cells", "brand") - buttonWidth(T("Menu"), "btn-quiet") - buttonWidth(T("Pause"), "btn") - 64;
      let used = 0;
      const chip = (id: string, text: string, cls: string): void => {
        if (!text) return;
        const w = textWidth(text, cls);
        if (used + w > room) return; // narrow phones: chips give way so Menu / Pause stay clear
        used += w + 16;
        ui.style(cls).id(id).label(text);
      };
      chip("hud-player", name, "status");
      chip("hud-sync", syncText, sync === "synced" ? "status-ok" : sync === "offline" ? "status-err" : "status-dim");
      chip("hud-deal", app.config && s ? app.config.dealId : "", "status");
      ui.spacer();
      button({ id: "btn-menu", text: T("Menu"), style: "btn-quiet", act: doMenu, disabled: !live });
      button({ id: "btn-pause", text: T("Pause"), act: doPause, disabled: !live || !s || app.phase !== "active" });
    }, { style: "topbar", width: L.lw, height: barH, spacing: 16, align: "center" });
  });
  rect(bar);

  // ---- tray (compact)
  if (!L.wide) {
    let items: Btn[] = [
      { id: "tray-undo", text: T("Undo"), style: "btn-tray", act: doUndo, disabled: !live },
      { id: "tray-hint", text: T("Hint"), style: "btn-tray", act: doHint, disabled: !live },
      { id: "tray-auto", text: T("Collect"), style: "btn-tray", act: doAuto, disabled: !live },
      { id: "tray-pause", text: T("Pause"), style: "btn-tray", act: doPause, disabled: !live || !s || app.phase !== "active" },
    ];
    if (platform.options.leftHanded) items = items.reverse();
    const bw = (L.lw - 16 - 3 * 8) / 4;
    const tray = ui.place("tray", { anchor: "bottom-start", x: 0, y: 0 }, () => {
      ui.row("tray-row", () => { for (const b of items) button(b, bw); }, { style: "tray", width: L.lw, spacing: 8 });
    });
    rect(tray);
    lastSize.set("tray", tray.height / sc);
  }

  // ---- rails
  if (L.wide) {
    rail("rail-left", "top-start", barH + pad, lw, rhei, (w) => leftRail(w, false));
    rail("rail-right", "top-end", barH + pad, rw, rhei, (w) => rightRail(w, live));
  } else if (L.landscape) {
    rail("rail-left", "top-start", barH + pad, lw, rhei, (w) => leftRail(w, true));
  } else {
    // Compact portrait: the rail is a strip above the table.
    const w = L.lw - 2 * pad;
    const strip = ui.place("rail-strip", { anchor: "top-start", x: pad, y: barH + pad }, () => {
      ui.column("strip-col", () => stripRail(w - 28), { style: "strip", width: w, spacing: 4 });
    });
    rect(strip);
    lastSize.set("strip", strip.height / sc);
  }
}

function rail(id: string, anchor: "top-start" | "top-end", topY: number, w: number, h: number, build: (w: number) => void): void {
  const inner = w - 30;
  const scroll = (lastSize.get(id) ?? 0) > h - 30;
  const r = ui.place(id, { anchor, x: 12, y: topY }, () => {
    ui.column(id, () => {
      const body = (): void => {
        const c = ui.column(`${id}-in`, () => build(inner - (scroll ? 14 : 0)), { spacing: 6, width: inner - (scroll ? 14 : 0) });
        lastSize.set(id, c.height / ui.preferences().scale);
      };
      if (scroll) ui.scrollArea(`${id}-scroll`, { width: inner, height: h - 30 }, body);
      else body();
    }, { style: "rail", width: w, height: h, spacing: 0 });
  });
  rect(r);
}
interface Hud { objective: string; progress: string; moves: string; time: string; score: string; undo: string; lesson: string }
function hud(): Hud {
  const s = app.session;
  if (!s) return { objective: objectiveText(), progress: T("{n} / 52 home", { n: 0 }), moves: T("{n} moves", { n: 0 }), time: "0:00", score: "0", undo: "0", lesson: "" };
  const st = s.state;
  const home = st.foundations.reduce((n, f) => n + f.length, 0);
  return {
    objective: objectiveText(),
    progress: T("{n} / 52 home", { n: home }),
    moves: st.constraints.moveLimit ? T("{n} moves / {max}", { n: st.moves, max: st.constraints.moveLimit }) : T("{n} moves", { n: st.moves }),
    time: fmtTime(st.elapsedMs) + (st.constraints.timeLimitMs ? ` / ${fmtTime(st.constraints.timeLimitMs)}` : ""),
    score: String(Sess.score(s).total),
    undo: String(s.undoStack.length),
    lesson: lessonText(),
  };
}
/** index.html #rail-left: the objective and the progress. */
function leftRail(w: number, small: boolean): void {
  const h = hud();
  const cls = small ? "text-small" : "text";
  heading("rail-heading", T("Objective").toUpperCase(), w);
  para(h.objective, w, cls, "hud-objective");
  heading("rail-heading", T("Progress").toUpperCase(), w);
  para(h.progress, w, cls, "hud-progress");
  para(h.moves, w, cls, "hud-moves");
  para(h.time, w, cls, "hud-time");
  para(`${T("Score")} ${h.score}`, w, cls, "hud-score");
  if (h.lesson) ui.column("lesson-banner", () => para(h.lesson, w - 24, "text-small", "hud-lesson"), { style: "lesson-banner", width: w });
}
/** Compact portrait: the rail as a wrapping strip (OBJECTIVE … PROGRESS 0 / 52 home · moves · time · score). */
function stripRail(w: number): void {
  const h = hud();
  const items: [string, string][] = [
    ["rail-heading", T("Objective").toUpperCase()], ["text-small", h.objective], ["rail-heading", T("Progress").toUpperCase()],
    ["text-small", h.progress], ["text-small", h.moves], ["text-small", h.time], ["text-small", `${T("Score")} ${h.score}`],
  ];
  const rows: [string, string][][] = [[]];
  let used = 0;
  for (const it of items) {
    const iw = textWidth(it[1], it[0]);
    if (iw > w) { rows.push([it], []); used = 0; continue; }
    if (rows[rows.length - 1]!.length && used + 14 + iw > w) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? 14 : 0) + iw;
    rows[rows.length - 1]!.push(it);
  }
  rows.filter((r) => r.length).forEach((r, i) => ui.row(`strip-r${i}`, () => {
    for (const [cls, text] of r) para(text, w, cls);
  }, { spacing: 14, align: "center" }));
  if (h.lesson) ui.column("lesson-banner", () => para(h.lesson, w - 24, "text-small", "hud-lesson"), { style: "lesson-banner", width: w });
}
/** index.html #rail-right: the actions with their keys. */
function rightRail(w: number, live: boolean): void {
  const h = hud();
  const playing = live && !!app.session && app.phase === "active";
  heading("rail-heading", T("Actions").toUpperCase(), w);
  const list: Btn[] = [
    { id: "btn-undo", text: T("Undo"), name: T("Undo"), kbd: keyOf("undo"), pill: h.undo, style: "btn-rail", act: doUndo, disabled: !playing },
    { id: "btn-hint", text: T("Hint"), kbd: keyOf("hint"), style: "btn-rail", act: doHint, disabled: !playing },
    { id: "btn-auto", text: T("Collect"), kbd: keyOf("auto"), style: "btn-rail", act: doAuto, disabled: !playing },
    { id: "btn-skip-anim", text: T("Settle"), style: "btn-rail", act: doSettle, disabled: !live },
    { id: "btn-restart", text: T("Restart"), style: "btn-rail", act: askRestart, disabled: !playing },
    { id: "btn-concede", text: T("Concede"), style: "btn-quiet", act: askConcede, disabled: !playing },
  ];
  for (const b of list) button(b, w);
}

// ------------------------------------------------------------------ the board's named targets and the cursor
const FW = FOUNDATION_WORDS;
function boardTargets(): void {
  const s = app.session;
  if (!s || app.screens.length) return;
  const st = s.state;
  const target = (name: string, loc: Loc, depth: number, covered: boolean): void => {
    const r = render.screenRect(loc, depth, covered);
    if (r && r.width > 0 && r.height > 0) ui.target(name, r, { role: "button" });
  };
  for (let i = 0; i < Rules.NUM_CELLS; i++) {
    if (i >= st.constraints.cellsAvailable) continue;
    const id = st.cells[i];
    target(id == null ? T("Empty cell {n}", { n: i + 1 }) : `${cardWords(id)}, ${T("cell {n}", { n: i + 1 })}`, { zone: "cell", index: i }, 0, false);
  }
  for (let f = 0; f < 4; f++) {
    const pile = st.foundations[f]!;
    target(pile.length ? `${cardWords(pile[pile.length - 1]!)}, ${T(FW[f]!)}` : T("{foundation}, empty", { foundation: T(FW[f]!) }),
      { zone: "foundation", index: f }, pile.length ? pile.length - 1 : 0, false);
  }
  for (let c = 0; c < 8; c++) {
    const col = st.tableau[c]!;
    if (!col.length) { target(T("Empty column {n}", { n: c + 1 }), { zone: "tableau", index: c }, 0, false); continue; }
    col.forEach((id, d) => target(`${cardWords(id)}, ${T("column {c}, card {n} of {total}", { c: c + 1, n: d + 1, total: col.length })}`,
      { zone: "tableau", index: c }, d, d < col.length - 1));
  }
  // The keyboard / pad cursor (the old DOM board's focus ring).
  const cur = app.cursor;
  if (cur) {
    const n = cur.zone === "tableau" ? st.tableau[cur.index]!.length : 0;
    const depth = cur.zone === "foundation" ? Math.max(0, st.foundations[cur.index]!.length - 1) : cur.depth;
    const r = render.screenRect({ zone: cur.zone, index: cur.index }, depth, cur.zone === "tableau" && depth < n - 1);
    if (r) {
      const sc = ui.preferences().scale, sa = frame().safeArea;
      ui.place("board-cursor", { anchor: "top-start", x: (r.x - sa.left) / sc - 3, y: (r.y - sa.top) / sc - 3 }, () => {
        ui.widget("", { role: "none", size: { width: r.width / sc + 6, height: r.height / sc + 6 }, draw: (q) => draw.box(q.x, q.y, q.width, q.height, "cursor") });
      });
      ui.target(cursorWords(), { x: r.x, y: r.y, width: 1, height: 1 }, { role: "label" });
    }
  }
}

// ------------------------------------------------------------------ toasts
function toasts(L: Layout): void {
  const f = frame(), sc = L.sc;
  if (app.toast && !app.screens.length) {
    const w = Math.min(view.width / sc * 0.9, 380);
    ui.place("toast", { anchor: "bottom", y: (f.height - view.y - view.height) / sc + 16 }, () =>
      ui.column("toast-col", () => para(app.toast!.text, w - 34, "toast-text", "toast-text"), { style: "toast", align: "center" }));
  }
  if (app.notice) {
    const w = Math.min(L.lw * 0.9, 420);
    ui.place("oc-toast", { anchor: "bottom", y: 16 }, () =>
      ui.column("oc-toast-col", () => para(app.notice!.text(), w - 34, "oc-toast-text", "oc-toast-text"), { style: "oc-toast", align: "center" }));
  }
}

// ------------------------------------------------------------------ overlay screens (ui.js openScreen)
const WIDE = new Set(["modes", "journey", "learn", "challenge-setup", "settings", "help", "boards"]);
function screenTitle(s: Screen): string {
  switch (s.name) {
    case "title": return "Open Cells";
    case "modes": return T("Choose a mode");
    case "journey": return T("Journey");
    case "stage-setup": return T("Stage {n} — {title}", { n: s.stage!.n, title: T(s.stage!.title) });
    case "learn": return T("Learn");
    case "practice-setup": return T("Practice");
    case "challenge-setup": return T("Challenge");
    case "daily-setup": return T("Daily Deal");
    case "chase-setup": return T("Score Chase");
    case "pause": return T("Paused");
    case "settings": return T("Settings");
    case "help": return T("How to play");
    case "boards": return T("Scores & achievements");
    case "results": return T("Results");
    case "confirm": return s.confirm === "restart" ? T("Restart deal") : s.confirm === "concede" ? T("Concede") : T("Erase local progress");
  }
}
function screens(L: Layout): void {
  const s = top();
  if (!s) return;
  const f = frame();
  // Key art backdrops under the title and results (index.html .screen-overlay[data-screen]).
  const art = app.screens.some((x) => x.name === "results") ? "results-art" : app.screens.some((x) => x.name === "title") ? "title-art" : null;
  if (art && !ui.preferences().highContrast) paint("screen-art", 0, 0, f.width, f.height, art);
  const outer = Math.min(WIDE.has(s.name) ? 860 : 560, L.lw - 32);
  const padX = L.lw < 700 ? 15 : 22;
  const inner = outer - 2 * padX - 4;
  const avail = Math.max(120, L.lh - 32);
  const key = `screen-${app.screens.length}-${s.name}`;
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const opening = f.frame - app.openedFrame <= 5;
  const title = screenTitle(s);
  const open = ui.dialog(title, "", true, () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => {
        // The heading with its persistent close control.
        ui.row(`${key}-head`, () => {
          heading("screen-title", title, inner - 60, "screen-title");
          ui.spacer();
          button({ id: "btn-close", text: "✕", name: T("Close {title}", { title }), style: "btn-quiet", act: () => closeTop() });
        }, { width: inner - (scroll ? 14 : 0), align: "center" });
        build(s, inner - (scroll ? 14 : 0), L);
      }, { style: "screen", width: outer - (scroll ? 14 : 0), spacing: 11, padding: { top: 14, bottom: 20, start: padX, end: padX } });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
  // Back / Escape closes the screen (not on the frame it opened: that press opened it).
  if (!open && fresh()) later(closeTop);
}
function build(s: Screen, w: number, L: Layout): void {
  switch (s.name) {
    case "title": titleScreen(w); break;
    case "modes": modesScreen(w); break;
    case "journey": journeyScreen(w); break;
    case "stage-setup": stageScreen(s.stage!, w); break;
    case "learn": learnScreen(w); break;
    case "practice-setup": practiceScreen(w); break;
    case "challenge-setup": challengeScreen(w); break;
    case "daily-setup": dailyScreen(w); break;
    case "chase-setup": chaseScreen(w); break;
    case "pause": pauseScreen(w); break;
    case "settings": settingsScreen(w); break;
    case "help": helpScreen(w); break;
    case "boards": boardsScreen(w); break;
    case "results": resultsScreen(w, L); break;
    case "confirm": confirmScreen(s.confirm!, w); break;
  }
}

// ------------------------------------------------------------------ title
function titleScreen(w: number): void {
  const save = platform.save();
  ui.column("title-hero", () => {
    ui.style("wordmark").id("wordmark").label("Open Cells");
    para(T("A brass-and-slate card puzzle. Four cells. Fifty-two cards. No hidden information."), w, "tag", "title-tag");
  }, { width: w, align: "center", spacing: 6 });
  ui.row("title-play", () => {
    button({ id: "btn-play", text: save.lastSnapshot ? T("Continue") : T("Play"), style: "btn-play", act: () => { closeAll(); actions.play(); } });
  }, { width: w, justify: "center" });
  flow("title-row", [
    { id: "btn-daily", text: T("Daily Deal"), act: () => { closeAll(); openScreen({ name: "daily-setup", daily: dailyInfo() }); } },
    { id: "btn-journey", text: T("Journey"), act: () => openScreen({ name: "journey" }) },
    { id: "btn-modes", text: T("Modes"), act: () => openScreen({ name: "modes" }) },
  ], w);
  flow("title-row2", [
    { id: "btn-learn", text: T("Learn"), style: "btn-quiet", act: () => openScreen({ name: "learn" }) },
    { id: "btn-scores", text: T("Scores"), style: "btn-quiet", act: () => openScreen({ name: "boards" }) },
    { id: "btn-settings", text: T("Settings"), style: "btn-quiet", act: () => openScreen({ name: "settings" }) },
    { id: "btn-help", text: T("Help"), style: "btn-quiet", act: () => openScreen({ name: "help" }) },
  ], w);
  const acct: Btn[] = [];
  if (!platform.signedIn()) acct.push({ id: "btn-sh-sign-in", text: S("signIn"), act: actions.signIn });
  if (platform.inviteLink()) acct.push({ id: "btn-sh-invite", text: S("invite"), act: actions.invite });
  if (acct.length) flow("title-account", acct, w);
  para(T("Journey: {done} of {total} stages · Daily streak: {streak}", { done: Object.keys(save.journey).length, total: Content.JOURNEY.length, streak: save.dailyStreak.count }), w, "dim-center", "title-progress");
  const d = dailyInfo();
  para(T("Daily deal: {date} · next in {wait}", { date: d.date, wait: fmtDuration(Content.msUntilNextUtcDay(platform.now())) }), w, "dim-center", "title-clock");
}

// ------------------------------------------------------------------ modes
const MODE_CARDS = [
  { id: "learn", title: N("Learn"), desc: N("Six short lessons. One rule at a time; you perform each move."), duration: N("2 min each"), ranked: false },
  { id: "journey", title: N("Journey"), desc: N("Forty authored stages. New constraints arrive one at a time, with mastery checks."), duration: N("5–10 min"), ranked: true },
  { id: "daily", title: N("Daily"), desc: N("One shared deal per UTC day. Same seed for everyone."), duration: N("~8 min"), ranked: true },
  { id: "practice", title: N("Practice"), desc: N("Pick a difficulty. Free undo, restart any time, never ranked."), duration: N("any length"), ranked: false },
  { id: "challenge", title: N("Challenge"), desc: N("Constrained deals: move limits, clocks, fewer cells."), duration: N("5–10 min"), ranked: true },
  { id: "chase", title: N("Score Chase"), desc: N("Seeded deals compared on the boards. Validate your replay, climb the list."), duration: N("~8 min"), ranked: true },
];
/** A grid of cards `min` px wide at least (CSS repeat(auto-fill, minmax(min, 1fr))). */
function cardGrid(id: string, count: number, w: number, min: number, gap: number, cell: (i: number, cw: number) => void): void {
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = (w - (cols - 1) * gap) / cols;
  ui.column(id, () => {
    for (let r = 0; r * cols < count; r++) {
      ui.row(`${id}-r${r}`, () => { for (let i = r * cols; i < Math.min(count, (r + 1) * cols); i++) cell(i, cw); }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}
function modesScreen(w: number): void {
  cardGrid("mode-grid", MODE_CARDS.length, w, 220, 13, (i, cw) => {
    const m = MODE_CARDS[i]!;
    ui.column(`mode-${m.id}`, () => {
      heading("card-h3", T(m.title), cw - 30);
      para(T(m.desc), cw - 30, "text-small");
      para(`${T(m.duration)} · ${m.ranked ? T("Ranked") : T("Unranked")}`, cw - 30, "dim-small");
      button({ id: `open-${m.id}`, text: T("Open"), name: `${T("Open")} ${T(m.title)}`, style: "btn-primary", act: () => { closeAll(); actions.mode(m.id); } });
    }, { style: "mode-card", width: cw, spacing: 6 });
  });
}

// ------------------------------------------------------------------ journey
function journeyScreen(w: number): void {
  const save = platform.save();
  para(T("Complete a stage to unlock the next. Mastery stages combine everything before them."), w);
  cardGrid("journey-grid", Content.JOURNEY.length, w, 64, 8, (i, cw) => {
    const st = Content.JOURNEY[i]!;
    const rec = save.journey[st.id];
    const unlocked = st.n === 1 || !!save.journey[Content.JOURNEY[st.n - 2]!.id];
    const stars = rec ? "★".repeat(rec.stars) + "☆".repeat(3 - rec.stars) : "";
    const cls = st.mastery ? (rec ? "journey-mastery-done" : "journey-mastery") : rec ? "journey-done" : "journey-cell";
    const name = T("Stage {n}: {title}", { n: st.n, title: T(st.title) })
      + (rec ? T(", completed, {stars} of 3 stars", { stars: rec.stars }) : unlocked ? T(", unlocked") : T(", locked"));
    const opts: ui.ButtonOptions = {
      content: () => ui.column(`j${st.n}-face`, () => {
        ui.style("journey-n").label(String(st.n));
        if (stars) ui.style("journey-stars").label(stars);
      }, { align: "center", spacing: 2 }),
    };
    if (!unlocked) opts.disabled = true;
    if (ui.style(cls, { width: cw, height: Math.max(64, cw) }).id(`stage-${st.n}`).button(name, opts) && fresh() && unlocked) later(() => openScreen({ name: "stage-setup", stage: st }));
  });
}
function constraintSummary(c: Constraints): string {
  const parts: string[] = [];
  if (c.cellsAvailable < 4) parts.push(T("{n} cells", { n: c.cellsAvailable }));
  if (c.moveLimit) parts.push(T("≤ {n} moves", { n: c.moveLimit }));
  if (c.timeLimitMs) parts.push(`≤ ${fmtTime(c.timeLimitMs)}`);
  if (c.noAuto) parts.push(T("no auto-collect"));
  return parts.length ? parts.join(" · ") : T("standard rules");
}
const FLAG_TEXT: Record<string, string> = { cells: N("cells"), "empty-columns": N("empty columns") };
function stageScreen(st: Stage, w: number): void {
  para(T("Difficulty {dots}", { dots: "●".repeat(st.difficulty) + "○".repeat(5 - st.difficulty) }), w);
  para(T("Rules: {rules}", { rules: constraintSummary(st.constraints) }), w);
  para(T("Par: {moves} moves, {time}. Seed {seed}. Ranked.", { moves: st.par.moves, time: fmtTime(st.par.timeMs), seed: st.seed }), w);
  if (st.tutorialFlags.length) para(T("Concept focus: {topics}", { topics: st.tutorialFlags.map((f) => T(FLAG_TEXT[f] ?? f)).join(", ") }), w);
  button({ id: "btn-begin", text: T("Begin stage"), style: "btn-primary", act: () => startJourney(st) });
  button({ id: "btn-back", text: T("Back"), style: "btn-quiet", act: () => closeTop() });
}

// ------------------------------------------------------------------ learn and setups
/** index.html .lesson-row: a status, a title with its text, and a button. */
function lessonRow(id: string, w: number, status: string | null, title: string, text: string, b: Btn): void {
  const bw = buttonWidth(b.text, b.style ?? "btn");
  const sw = status ? 26 : 0;
  const tw = w - 28 - bw - sw - 26;
  ui.row(id, () => {
    if (status) ui.column(`${id}-s`, () => ui.style("lesson-status").label(status), { width: sw });
    ui.column(`${id}-t`, () => { para(title, tw, "strong"); para(text, tw, "dim-small"); }, { width: tw, spacing: 2 });
    button(b);
  }, { style: "lesson-row", width: w, spacing: 13, align: "center" });
}
function learnScreen(w: number): void {
  const save = platform.save();
  para(T("Lessons ask you to perform each rule yourself. Progress is saved."), w);
  Content.LESSONS.forEach((ls, i) => {
    const done = !!save.lessons[ls.id];
    lessonRow(`lesson-${i}`, w, done ? "✓" : `${i + 1}.`, T(ls.title), T(ls.intro),
      { id: `btn-lesson-${i}`, text: done ? T("Replay") : T("Start"), name: `${done ? T("Replay") : T("Start")}: ${T(ls.title)}`, act: () => startLesson(ls) });
  });
}
function practiceScreen(w: number): void {
  para(T("Practice is never ranked. Undo is free; restart any time."), w);
  Content.PRACTICE_DIFFICULTIES.forEach((d, i) => {
    lessonRow(`practice-${i}`, w, null, T(d.title), `${T(d.description)} (${constraintSummary(d.constraints)})`,
      { id: `btn-practice-${d.id}`, text: T("Deal"), name: `${T("Deal")}: ${T(d.title)}`, style: "btn-primary", act: () => startPractice(d) });
  });
}
function challengeScreen(w: number): void {
  para(T("Constrained deals. Your score goes to the challenge boards."), w);
  Content.CHALLENGES.forEach((ch, i) => {
    lessonRow(`challenge-${i}`, w, null, `${T(ch.title)}  ${"●".repeat(ch.difficulty)}`, `${T(ch.description)} (${constraintSummary(ch.constraints)})`,
      { id: `btn-challenge-${ch.id}`, text: T("Play"), name: `${T("Play")}: ${T(ch.title)}`, style: "btn-primary", act: () => startChallenge(ch) });
  });
}
function dailyScreen(w: number): void {
  const d = top()?.daily ?? dailyInfo();
  para(T("Deal {date} · seed {seed} · standard rules · par {moves} moves.", { date: d.date, seed: d.seed, moves: d.par.moves }), w);
  para(platform.clockSynced() ? T("Clock synchronized with StarHermit.") : T("Using this device’s clock for the daily boundary."), w);
  para(T("One result per day counts for your streak. Ranked."), w);
  button({ id: "btn-play-daily", text: T("Play today’s deal"), style: "btn-primary", act: () => startDaily(d) });
}
function chaseScreen(w: number): void {
  para(T("Enter a seed (or roll one). Everyone with the same seed plays the same deal; results go to the seed board."), w);
  const play = (): void => { const v = app.chaseSeed.trim() || rollSeed(); app.chaseSeed = ""; startChase(v); };
  const bw = buttonWidth(T("Play seed"), "btn-primary");
  ui.row("chase-form", () => {
    app.chaseSeed = ui.id("chase-seed").textField(T("Challenge seed"), app.chaseSeed, {
      maxChars: 40, width: Math.max(120, w - bw - 12), placeholder: T("e.g. {seed}", { seed: "brass-owl-42" }),
    });
    if (ui.submitted(T("Challenge seed")) && fresh()) later(play);
    button({ id: "btn-play-seed", text: T("Play seed"), style: "btn-primary", act: play });
  }, { spacing: 8, width: w, align: "center" });
  button({ id: "btn-roll", text: T("Roll a random seed"), act: () => startChase(rollSeed()) });
}

// ------------------------------------------------------------------ pause, confirm
function pauseScreen(w: number): void {
  const bw = Math.min(w, 280);
  button({ id: "btn-resume", text: T("Resume"), style: "btn-primary", act: () => { closeAll(); resumeGame(); } }, bw);
  button({ id: "btn-restart-deal", text: T("Restart deal"), act: () => { closeAll(); app.phase = "active"; resumeGame(); retryDeal(); } }, bw);
  button({ id: "btn-pause-settings", text: T("Settings"), act: () => openScreen({ name: "settings" }) }, bw);
  button({ id: "btn-pause-help", text: T("Help"), act: () => openScreen({ name: "help" }) }, bw);
  button({ id: "btn-leave", text: T("Leave deal"), style: "btn-quiet", act: () => { closeAll(); leaveToTitle(); } }, bw);
}
function confirmScreen(kind: "restart" | "concede" | "wipe", w: number): void {
  para(kind === "restart" ? T("Restart this deal from the beginning?") : kind === "concede" ? T("Concede this deal?") : T("Erase all local progress, scores, and settings?"), w);
  flow("confirm-row", [
    { id: "btn-confirm-yes", text: T("Yes"), style: "btn-primary", act: () => confirmYes(kind) },
    { id: "btn-confirm-cancel", text: T("Cancel"), act: () => closeTop() },
  ], w, 10, "start");
}

// ------------------------------------------------------------------ settings
const PALETTES: [string, string][] = [
  ["standard", N("Standard red/black")], ["deuteranopia", N("Deuteranopia-safe (blue/orange)")], ["tritanopia", N("Tritanopia-safe (blue/red)")],
];
function group(id: string, title: string, w: number, body: () => void): void {
  ui.column(id, () => { heading("group-h3", T(title), w); body(); }, { style: "settings-group", width: w, spacing: 8 });
}
/** A labelled select (index.html .setting-select). */
function field(id: string, label: string, idx: number, options: string[], w: number, set: (i: number) => void): void {
  ui.column(`${id}-field`, () => {
    para(label, w, "text", `${id}-label`);
    const pick = ui.id(id).select(label, idx, options, { width: Math.min(w, 340) } as ui.WidgetOptions);
    if (pick !== idx) later(() => set(pick));
  }, { spacing: 4, width: w });
}
/** index.html .setting-toggle: a check box with a strong label and a small description (wrapped; built-in check box labels don't). */
function toggle(id: string, label: string, desc: string, on: boolean, w: number, set: (v: boolean) => void): void {
  const tw = w - 56;
  ui.row(`${id}-row`, () => {
    const res = ui.id(id).widget(T(label), {
      role: "checkbox", checked: on, size: { width: 44, height: 44 }, description: T(desc),
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("accent") : token("panel-2"));
        draw.strokeRoundRect(bx, by, box, box, 4, token("trim"), 1);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: "#141414", align: "center", weight: "bold" });
      },
    });
    if (res.activated && fresh()) later(() => set(!on));
    ui.column(`${id}-txt`, () => { para(T(label), tw, "strong"); para(T(desc), tw, "dim-small"); }, { spacing: 1, width: tw });
  }, { spacing: 12, width: w, align: "center" });
}
function settingsScreen(w: number): void {
  const o = platform.options;
  para(T("Sound, graphics, language, larger text, high contrast and reduced motion are in the StarHermit Options."), w, "dim", "options-note");
  flow("settings-runtime", [
    { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
    { id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() },
  ], w, 10, "start");
  group("set-graphics", N("Graphics"), w, () => {
    const themes = Content.THEMES.map((t) => T(t.name));
    field("set-theme", T("Theme"), Math.max(0, Content.THEMES.findIndex((t) => t.id === o.theme)), themes, w, (i) => {
      const id = Content.THEMES[i]!.id;
      if (Store.THEME_IDS.includes(id)) platform.setOption("theme", id);
    });
  });
  group("set-access", N("Accessibility"), w, () => {
    field("set-palette", T("Suit color palette"), Math.max(0, PALETTES.findIndex(([id]) => id === o.colorPalette)), PALETTES.map(([, l]) => T(l)), w, (i) => {
      platform.setOption("colorPalette", PALETTES[i]![0]);
    });
    toggle("set-left", N("Left-handed layout"), N("Mirrors the action tray."), o.leftHanded, w, (v) => platform.setOption("leftHanded", v));
    toggle("set-hold", N("Hold to drag"), N("Require holding a card to drag; tap toggles selection otherwise."), o.holdToDrag, w, (v) => platform.setOption("holdToDrag", v));
    toggle("set-haptics", N("Haptics"), N("Vibration feedback on supporting devices."), o.haptics, w, (v) => platform.setOption("haptics", v));
  });
  group("set-controls", N("Controls"), w, () => {
    const k = keysFor;
    para(T("Keyboard: {nav} navigate, Enter/Space select or place, {cancel} cancel/pause, {pause} pause, {undo} undo, {hint} hint, {auto} collect, {restart} restart, {camera} camera reset.", {
      nav: [k("nav_left"), k("nav_right"), k("nav_up"), k("nav_down")].join(" "), cancel: k("cancel"), pause: k("pause"), undo: k("undo"),
      hint: k("hint"), auto: k("auto"), restart: k("restart"), camera: k("camera_reset"),
    }), w, "text", "keys-line");
    para(T("Gamepad: stick or D-pad navigates, A confirms, B cancels, Start pauses."), w);
  });
  group("set-data", N("Data"), w, () => {
    button({ id: "btn-wipe", text: T("Erase local progress"), style: "btn-quiet", act: () => openScreen({ name: "confirm", confirm: "wipe" }) });
  });
  button({ id: "btn-settings-done", text: T("Done"), style: "btn-primary", act: () => closeTop() });
}

// ------------------------------------------------------------------ help
const HELP_CARDS: [string, string][] = [
  [N("Objective"), N("Move all 52 cards to the four foundations — one per suit, ace up to king.")],
  [N("Tableau"), N("Eight columns build downward in alternating colors. Only ordered runs travel together.")],
  [N("Cells"), N("Four temporary cells, one card each. They are your working room — empty them again soon.")],
  [N("Supermoves"), N("Run length you may move = (free cells + 1) × 2^(empty columns). Free space is power.")],
  [N("Empty columns"), N("Any card or run may take an empty column. They double your moving capacity.")],
  [N("Collect"), N("Cards that can never be needed again may be swept home automatically with Collect (A).")],
  [N("Scoring"), N("Completion first, then efficiency: fewer moves and a calm clock beat haste. Invalid attempts cost a little; undos cost a little.")],
];
function helpScreen(w: number): void {
  cardGrid("help-grid", HELP_CARDS.length, w, 220, 13, (i, cw) => {
    const [t, d] = HELP_CARDS[i]!;
    ui.column(`help-${i}`, () => { heading("card-h3", T(t), cw - 30); para(T(d), cw - 30, "text-small"); }, { style: "mode-card", width: cw, spacing: 6 });
  });
  const k = keysFor;
  para(T("Controls — {nav} navigate, Enter/Space select or place, {cancel} cancels, {undo} undo, {hint} hint, {auto} collect, {restart} restart (with confirmation), {camera} camera reset.", {
    nav: [k("nav_left"), k("nav_right"), k("nav_up"), k("nav_down")].join(" "), cancel: k("cancel"), undo: k("undo"),
    hint: k("hint"), auto: k("auto"), restart: k("restart"), camera: k("camera_reset"),
  }), w, "text", "help-keys");
  para(T("Pointer and touch: drag a card or run onto its target, or tap it and then tap the target; double-tap sends a card home or to a free cell."), w, "text", "help-pointer");
  button({ id: "btn-help-back", text: T("Back"), style: "btn-primary", act: () => closeTop() });
}

// ------------------------------------------------------------------ boards and achievements
let hosted: platform.Hosted | null | undefined;
let hostedFor = -1;
/** A table of columns sized by share, each at least its heading's longest word. */
function table(id: string, w: number, heads: string[], shares: number[], rows: string[][], numeric: boolean[]): void {
  const word = (t: string): number => Math.max(...t.split(" ").map((x) => textWidth(x, "strong"))) + 22;
  const total = shares.reduce((a, b) => a + b, 0);
  const widths = shares.map((s, i) => Math.max(word(heads[i]!), (w * s) / total));
  const k = w / widths.reduce((a, b) => a + b, 0);
  const cw = widths.map((x) => x * k);
  const row = (rid: string, cells: string[], cls: string): void => {
    ui.row(rid, () => cells.forEach((c, i) => ui.column(`${rid}-${i}`, () => para(c, cw[i]! - 20, numeric[i] && cls === "text" ? "score-num" : cls), { width: cw[i]!, align: numeric[i] ? "end" : "start", padding: { end: 6 } })), { style: "score-row", width: w, spacing: 0 });
  };
  ui.column(id, () => {
    row(`${id}-h`, heads, "strong");
    rows.forEach((r, i) => row(`${id}-${i}`, r, "text"));
  }, { width: w, spacing: 0 });
}
function boardTable(id: string, entries: BoardEntry[], w: number): void {
  if (!entries.length) { para(T("No results yet."), w, "dim"); return; }
  table(id, Math.min(w, 460), ["#", T("Score"), T("Deal"), T("Moves"), T("Time")], [1, 2, 4, 2, 2],
    entries.slice(0, 10).map((e, i) => [String(i + 1), String(e.score.total), e.dealId, String(e.moves), fmtTime(e.durationMs)]), [true, true, false, true, true]);
}
function boardsScreen(w: number): void {
  if (platform.signedIn()) {
    if (hostedFor !== app.openedFrame) { hostedFor = app.openedFrame; hosted = undefined; void platform.hostedLeaderboard().then((r) => { hosted = r; }); }
    heading("group-h3", T("StarHermit leaderboard"), w);
    const lb = hosted;
    if (lb === undefined) para(T("Loading…"), w, "dim");
    else if (!lb) para(T("Global leaderboard unavailable — local records below."), w, "dim");
    else {
      if (lb.me && (lb.me.rank != null || lb.me.score != null)) {
        para(lb.me.score == null ? T("Your best: rank {rank}.", { rank: lb.me.rank ?? "" }) : lb.me.rank != null
          ? T("Your best: {score} · rank {rank}.", { score: lb.me.score, rank: lb.me.rank }) : T("Your best: {score}.", { score: lb.me.score }), w, "dim");
      } else if (!lb.entries.length) para(T("No global entries yet — local records below."), w, "dim");
      if (lb.entries.length) table("hosted", Math.min(w, 460), ["#", T("Player"), T("Score")], [1, 4, 2], lb.entries.map((e) => [String(e.rank), e.name || T("Player"), String(e.score)]), [true, false, true]);
    }
  }
  const labels: [string, string][] = [["daily", N("Daily board")], ["journey", N("Journey board")], ["chase", N("Score chase")], ["challenge", N("Challenge board")]];
  for (const [name, label] of labels) {
    heading("group-h3", T(label), w);
    boardTable(`board-${name}`, platform.getBoard(name), w);
  }
  heading("group-h3", T("Practice (casual, unvalidated)"), w);
  para(T("This board is local and unvalidated — casual only."), w, "dim-small");
  boardTable("board-practice", platform.getBoard("practice-local"), w);
  heading("group-h3", T("Achievements"), w);
  const save = platform.save();
  ui.column("ach-list", () => {
    for (const a of Content.ACHIEVEMENTS) {
      const on = !!save.achievements[a.key];
      ui.row(`ach-${a.key}`, () => {
        para(`${on ? "✓ " : ""}${T(a.title)}`, w * 0.45, on ? "ach-on" : "ach-off");
        para(`— ${T(a.description)}`, w * 0.55 - 8, on ? "text" : "ach-off");
      }, { spacing: 8, width: w });
    }
  }, { spacing: 6, width: w });
}

// ------------------------------------------------------------------ results
function resultsScreen(w: number, L: Layout): void {
  const r = app.results;
  if (!r) return;
  const key = r.status === "won" ? N("Deal cleared.") : r.reason === "conceded" ? N("Deal conceded.") : r.reason === "move-limit-exceeded" ? N("Out of moves.")
    : r.reason === "time-limit-exceeded" ? N("Out of time.") : N("Deal over.");
  para(T(key), w, "results-headline", "results-headline");
  const rows: [string, number][] = [
    [N("Cards home"), r.score.completion], [N("Win bonus"), r.score.winBonus], [N("Move efficiency"), r.score.efficiency],
    [N("Time bonus"), r.score.timeBonus], [N("Invalid attempts"), r.score.invalidPenalty], [N("Undos"), r.score.undoPenalty],
  ];
  const tw = Math.min(w, 460), c2 = 110;
  ui.column("score-table", () => {
    rows.forEach(([label, v], i) => ui.row(`score-${i}`, () => {
      ui.column(`score-${i}-a`, () => para(T(label), tw - c2 - 20, "text"), { width: tw - c2 });
      ui.column(`score-${i}-b`, () => para(`${v > 0 ? "+" : ""}${v}`, c2 - 20, "score-num"), { width: c2, align: "end", padding: { end: 10 } });
    }, { style: "score-row", width: tw, spacing: 0 }));
    ui.row("score-total", () => {
      ui.column("score-total-a", () => para(T("Total"), tw - c2 - 20, "total"), { width: tw - c2 });
      ui.column("score-total-b", () => para(String(r.score.total), c2 - 20, "total-num", "score-total-n"), { width: c2, align: "end", padding: { end: 10 } });
    }, { style: "score-row-last", width: tw, spacing: 0 });
  }, { width: tw, spacing: 0 });
  para(r.ranked
    ? T("{moves} moves · {time} · deal {deal} · ranked", { moves: r.moves, time: fmtTime(r.elapsedMs), deal: r.dealId })
    : T("{moves} moves · {time} · deal {deal} · unranked", { moves: r.moves, time: fmtTime(r.elapsedMs), deal: r.dealId }), w, "dim-small", "results-meta");
  if (r.stars) para("★".repeat(r.stars) + "☆".repeat(3 - r.stars), w, "results-stars", "results-stars");
  if (r.achievements.length) {
    heading("group-h3", T("Achievements unlocked"), w);
    r.achievements.forEach((a: Achievement, i) => para(`✓ ${T(a.title)} — ${T(a.description)}`, w, "text", `results-ach-${i}`));
  }
  const lb = leaderboardLine();
  if (lb) para(lb, w, "dim-small", "results-lb");
  const list: Btn[] = [];
  if (r.nextLabel) list.push({ id: "btn-results-next", text: T(r.nextLabel), style: "btn-primary", act: nextAfterResults });
  list.push({ id: "btn-results-retry", text: T("Retry"), act: retryDeal });
  list.push({ id: "btn-results-leave", text: T("Leave"), style: "btn-quiet", act: leaveToTitle });
  void L;
  flow("results-row", list, w);
}
