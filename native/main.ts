// Open Cells on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js), content
// (src/content.js) and session (src/session.js: validated commands, undo,
// replay envelopes, hints, lesson steps) are the browser build's, unchanged in
// what they decide; this module is what src/main.js did around them — the app
// state machine (title → mode screens → active ⇄ paused → results), starting
// every mode (Learn, Journey, Daily, Practice, Challenge, Score Chase), resuming
// the saved deal, the session's events (sounds, sparks, the camera nudge,
// announcements, the lesson steps), selection and moves by taps, drags,
// double taps, keys and pads (the board cursor stands in for the old DOM
// board's focus), hints, Collect, undo, restart and concede with an inline
// confirmation, the clock, the results with stars, achievements, the local
// boards and the high-score post, and the lifecycle (a hidden window pauses
// the deal, as visibilitychange did). Screens are drawn by screens.ts
// (starhermit:ui), the desk by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps: the deal's clock advances 250 ms every
// 15 steps of 1/60 s while the deal is active (main.js ticked every 250 ms of
// wall time), so a paused game, a hidden window and slow frames never move it
// and play scripts replay exactly.
import "./classic.ts";
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import {
  Content, Rules, Sess, type Achievement, type Challenge, type Config, type Daily, type Difficulty, type Lesson, type Loc,
  type Score, type Session, type SessionEvent, type Stage,
} from "./classic.ts";
import * as audio from "./audio.ts";
import { N, S, T, cardWords, fmtTime } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type ScreenName =
  | "title" | "modes" | "journey" | "stage-setup" | "learn" | "practice-setup" | "challenge-setup" | "daily-setup" | "chase-setup"
  | "pause" | "settings" | "help" | "boards" | "results" | "confirm";
export interface Screen { name: ScreenName; stage?: Stage; daily?: Daily; confirm?: "restart" | "concede" | "wipe" }
export interface Selection { loc: Loc; count: number; cardIds: number[] }
export interface Results {
  status: string; reason: string | null; score: Score; moves: number; invalid: number; undos: number; elapsedMs: number;
  dealId: string; ranked: boolean; mode: string; stars: number; achievements: Achievement[]; nextLabel: string | null;
}

export const app = {
  phase: "title" as "title" | "active" | "paused" | "results",
  /** The open screens, top last (ui.js openStack). */
  screens: [] as Screen[],
  /** Frame the top screen opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  session: null as Session | null,
  config: null as Config | null,
  selection: null as Selection | null,
  hintAction: null as { from: Loc; to: Loc } | null,
  cmdSeq: 0,
  lastTap: { cardId: -1, at: -10 },
  /** The keyboard / pad board cursor (board-dom.js focus): a location and, in a column, a card depth. */
  cursor: null as { zone: Loc["zone"]; index: number; depth: number } | null,
  results: null as Results | null,
  lb: null as platform.Posted | "posting" | null,
  /** The old #toast (refusals) and .oc-toast (account notices). */
  toast: null as { text: string; until: number } | null,
  notice: null as { text: () => string; until: number } | null,
  chaseSeed: "",
};
const now = (): number => frame().time;
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
function toast(text: string): void { app.toast = { text, until: now() + 2.6 }; }
export function notice(text: () => string): void { app.notice = { text, until: now() + 3.2 }; announce(text()); }
function haptic(ms: number): void { if (platform.options.haptics) { try { vibrate(ms); } catch { /* no motor */ } } }
function cmdId(): string { return `c${++app.cmdSeq}`; }
/** Rules/session refusals carry English sentences; two embed numbers (main.js refusalText). */
function refusalText(msg: string | undefined): string {
  const m = /^Not enough free cells to move (\d+) cards \(max (\d+)\)\.$/.exec(msg || "");
  if (m) return T("Not enough free cells to move {n} cards (max {max}).", { n: m[1]!, max: m[2]! });
  if (/^The deal is already /.test(msg || "")) return T("The deal is already over.");
  return T(msg || "That move is not legal.");
}
const ZONE_WORDS: Record<string, string> = { cell: N("cell"), foundation: N("foundation"), tableau: N("column") };

// ------------------------------------------------------------------ screens (ui.js openScreen / closeTop)
export function top(): Screen | null { return app.screens[app.screens.length - 1] ?? null; }
export function openScreen(s: Screen): void {
  app.screens.push(s);
  app.openedFrame = frame().frame;
  app.focusNext = null;
  ui.setFocus(null);
  refreshActive();
}
/** Closes the top screen; closing the pause screen resumes (ui.js onOverlayClosed). */
export function closeTop(): void {
  const s = app.screens.pop();
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  if (s?.name === "pause" && app.phase === "paused") resumeGame();
  refreshActive();
}
export function closeAll(): void {
  app.screens = [];
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  refreshActive();
}
/** The desk draws unless the title or results key art covers the whole window. */
function refreshActive(): void {
  const covered = app.screens.some((s) => s.name === "title" || s.name === "results");
  render.setActive(!covered);
}

// ------------------------------------------------------------------ title and modes
export function showTitle(): void {
  app.phase = app.phase === "results" || !app.session ? "title" : app.phase;
  if (!app.session) app.phase = "title";
  app.screens = [];
  openScreen({ name: "title" });
}
export function dailyInfo(): Daily { return Content.dailyInfo(platform.now()); }
export const actions = {
  play(): void {
    if (platform.save().lastSnapshot) { resumeSnapshot(); return; }
    startPractice(Content.PRACTICE_DIFFICULTIES[1]!);
  },
  mode(id: string): void {
    if (id === "learn") openScreen({ name: "learn" });
    else if (id === "journey") openScreen({ name: "journey" });
    else if (id === "daily") openScreen({ name: "daily-setup", daily: dailyInfo() });
    else if (id === "practice") openScreen({ name: "practice-setup" });
    else if (id === "challenge") openScreen({ name: "challenge-setup" });
    else if (id === "chase") openScreen({ name: "chase-setup" });
  },
  signIn(): void { void requestSignIn().catch(() => undefined); },
  invite(): void {
    const link = platform.inviteLink();
    if (!link) return;
    try { clipboard.writeText(link); notice(() => S("copied")); } catch { notice(() => S("copyFailed")); }
  },
};

// ------------------------------------------------------------------ starting modes
export function startJourney(st: Stage): void {
  startSession({
    mode: "journey", dealId: st.id, seed: st.seed, constraints: st.constraints, par: st.par, ranked: true, board: "journey",
    journeyStage: st, theme: st.theme,
  });
}
export function startLesson(ls: Lesson): void {
  startSession({
    mode: "learn", dealId: ls.id, seed: 1, tableau: ls.setup(),
    constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: false }, par: null, ranked: false, lesson: ls,
  });
}
let practiceSeq = 0;
/** Practice deals a fresh seed (main.js Math.random): the device clock and a counter, hashed. */
function freshSeed(): number { return Rules.hashString(`practice/${Date.now()}/${++practiceSeq}/${frame().frame}`) & 0x7fffffff; }
export function startPractice(diff: Difficulty): void {
  const seed = freshSeed();
  startSession({
    mode: "practice", dealId: `practice-${seed}`, seed, constraints: diff.constraints, par: { moves: 130, timeMs: 420000 },
    ranked: false, board: "practice-local",
  });
}
export function startChallenge(ch: Challenge): void {
  startSession({ mode: "challenge", dealId: ch.id, seed: Content.challengeSeed(ch), constraints: ch.constraints, par: ch.par, ranked: true, board: "challenge", challenge: ch });
}
export function startDaily(d: Daily): void {
  startSession({ mode: "daily", dealId: d.id, seed: d.seed, constraints: d.constraints, par: d.par, ranked: true, board: "daily" });
}
export function startChase(seedStr: string): void {
  startSession({
    mode: "chase", dealId: `chase-${seedStr}`, seed: Rules.hashString(`open-cells/chase/${seedStr}`),
    constraints: { cellsAvailable: 4, moveLimit: null, timeLimitMs: null, noAuto: false }, par: { moves: 120, timeMs: 360000 }, ranked: true, board: "chase",
  });
}
export function rollSeed(): string { return `roll-${(freshSeed() % 1e9).toString(36)}`; }

// ------------------------------------------------------------------ session lifecycle
function themeFor(cfg: Config | null): string { return cfg?.theme && cfg.theme !== "brass-slate" ? cfg.theme : platform.options.theme; }
function attach(cfg: Config, session: Session): void {
  app.config = cfg;
  app.session = session;
  app.selection = null;
  app.hintAction = null;
  app.cursor = null;
  app.results = null;
  app.lb = null;
  app.phase = "active";
  ticks = 0;
  Sess.on(session, (e, s) => onSessionEvent(e, s));
  render.clearCards();
  // Stage themes are presentation-only data; honoured per deal.
  render.setTheme(themeFor(cfg));
  closeAll();
}
function startSession(cfg: Config): void {
  app.cmdSeq = 0;
  const session = Sess.createSession({
    seed: cfg.seed, dealId: cfg.dealId, constraints: cfg.constraints, par: cfg.par, tableau: cfg.tableau, mode: cfg.mode, ranked: cfg.ranked,
    lesson: cfg.lesson ? { def: cfg.lesson, stepIndex: 0 } : null,
  });
  attach(cfg, session);
  render.syncState(session.state, true);
  audio.play("deal");
  announce(`${objectiveText()} ${T("Deal {id}.", { id: cfg.dealId })}`);
  if (cfg.lesson) showLessonStep();
}
export function objectiveText(): string {
  const c = app.config;
  const base = T("Build all four foundations, ace to king.");
  if (!c) return base;
  const cons = c.constraints;
  if (c.mode === "learn" && c.lesson) return `${T(c.lesson.title)}: ${c.lesson.steps[0] ? T(c.lesson.steps[0].text) : base}`;
  const time = cons.timeLimitMs ? fmtTime(cons.timeLimitMs) : null;
  if (cons.moveLimit && time) return `${base} ${T("Win within {n} moves and within {time}.", { n: cons.moveLimit, time })}`;
  if (cons.moveLimit) return `${base} ${T("Win within {n} moves.", { n: cons.moveLimit })}`;
  if (time) return `${base} ${T("Win within {time}.", { time })}`;
  return base;
}
function resumeSnapshot(): void {
  const snap = platform.save().lastSnapshot;
  if (!snap) return;
  try {
    const cfg = snap.config;
    // Lesson setups are functions: the stored copy is plain data, so take the lesson from the content.
    if (cfg.lesson) cfg.lesson = Content.LESSONS.find((l) => l.id === cfg.lesson!.id) ?? cfg.lesson;
    if (cfg.journeyStage) cfg.journeyStage = Content.JOURNEY.find((s) => s.id === cfg.journeyStage!.id) ?? cfg.journeyStage;
    const session = Sess.createSession({
      seed: cfg.seed, dealId: cfg.dealId, constraints: cfg.constraints, par: cfg.par, tableau: cfg.tableau, mode: cfg.mode, ranked: cfg.ranked,
      lesson: cfg.lesson ? { def: cfg.lesson, stepIndex: snap.lessonStep || 0 } : null,
    });
    session.state = Rules.deserialize(snap.state);
    session.log = snap.log || [];
    app.cmdSeq = snap.cmdSeq || 0;
    attach(cfg, session);
    render.syncState(session.state, true);
    announce(T("Resumed deal {id}. While you were away the clock was paused.", { id: cfg.dealId }));
  } catch {
    platform.save().lastSnapshot = null;
    platform.persistSave();
    startPractice(Content.PRACTICE_DIFFICULTIES[1]!);
  }
}
function saveSnapshot(): void {
  const s = app.session;
  if (!s || !app.config || app.phase === "results") return;
  platform.save().lastSnapshot = {
    config: JSON.parse(JSON.stringify(app.config)) as Config, state: Rules.serialize(s.state), log: s.log, cmdSeq: app.cmdSeq,
    lessonStep: s.lesson ? s.lesson.stepIndex : 0,
  };
  platform.persistSave();
}
let snapshotAt = -10;
function saveSnapshotThrottled(): void { if (now() - snapshotAt > 2) { snapshotAt = now(); saveSnapshot(); } }

export function retryDeal(): void {
  const cfg = app.config;
  if (!cfg) { showTitle(); return; }
  if (cfg.mode === "practice") startPractice(Content.PRACTICE_DIFFICULTIES[1]!);
  else startSession(cfg);
}
export function leaveToTitle(): void {
  app.session = null;
  app.phase = "title";
  render.clearCards();
  showTitle();
}
export function nextAfterResults(): void {
  const cfg = app.config;
  if (cfg && cfg.mode === "journey" && cfg.journeyStage) {
    const next = Content.JOURNEY[cfg.journeyStage.n];
    if (next) { startJourney(next); return; }
  }
  if (cfg && cfg.mode === "learn" && cfg.lesson) {
    const idx = Content.LESSONS.findIndex((l) => l.id === cfg.lesson!.id);
    if (idx >= 0 && idx + 1 < Content.LESSONS.length) { startLesson(Content.LESSONS[idx + 1]!); return; }
  }
  leaveToTitle();
}

// ------------------------------------------------------------------ the clock
let ticks = 0;
let hidden = false;
onFixedUpdate(() => {
  if (app.phase !== "active" || hidden || !app.session || app.session.state.status !== "active") return;
  if (++ticks < 15) return;
  ticks = 0;
  Sess.execute(app.session, { type: "tick", elapsedMs: 250 });
});

// ------------------------------------------------------------------ session events
function onSessionEvent(event: SessionEvent, session: Session): void {
  if (session !== app.session) return;
  const st = session.state;
  if (event.type === "move") {
    const to = event.command?.to;
    audio.play(to?.zone === "foundation" ? "foundation" : to?.zone === "cell" ? "cell" : "drop");
    if (to?.zone === "foundation") render.playEvent("foundation", to);
    clearSelection();
    render.syncState(st, false);
    audio.setMusicIntensity(st.foundations.reduce((n, f) => n + f.length, 0) / 52);
    saveSnapshotThrottled();
  } else if (event.type === "invalid") {
    audio.play("invalid");
    render.playEvent("invalid");
    announce(refusalText(event.message), true);
    toast(refusalText(event.message));
  } else if (event.type === "undo") {
    audio.play("undo");
    clearSelection();
    render.syncState(st, false);
    announce(T("Undone."));
  } else if (event.type === "lesson-step") {
    audio.play("lesson-step");
    if (event.done) queueMicrotask(lessonComplete);
    else showLessonStep();
  } else if (event.type === "terminal") {
    queueMicrotask(onTerminal);
  }
}

// ------------------------------------------------------------------ terminal
function onTerminal(): void {
  const session = app.session, cfg = app.config;
  if (!session || !cfg || app.phase === "results") return;
  const st = session.state;
  app.phase = "results";
  render.settle();
  const save = platform.save();
  const score = Sess.score(session);
  const won = st.status === "won";
  save.totals.played += 1;
  st.foundations.forEach((f) => { save.totals.foundations += f.length; });
  if (won) save.totals.wins += 1;
  let stars = 0;
  if (cfg.mode === "journey" && won && cfg.journeyStage && cfg.par) {
    const stg = cfg.journeyStage;
    stars = 1 + (st.moves <= cfg.par.moves ? 1 : 0) + (st.elapsedMs <= cfg.par.timeMs ? 1 : 0);
    const prev = save.journey[stg.id];
    if (!prev || stars > prev.stars || score.total > prev.bestScore) {
      save.journey[stg.id] = {
        stars: Math.max(stars, prev ? prev.stars : 0), bestScore: Math.max(score.total, prev ? prev.bestScore : 0),
        bestMoves: prev && prev.bestMoves != null ? Math.min(st.moves, prev.bestMoves) : st.moves, completedAt: new Date().toISOString(),
      };
    }
  }
  if (cfg.mode === "daily" && won) {
    const date = cfg.dealId.replace("daily-", "");
    const already = save.dailies[date];
    save.dailies[date] = { score: score.total, won: true, completedAt: new Date().toISOString() };
    if (!already) {
      const yesterday = new Date(platform.now().getTime() - 86400000).toISOString().slice(0, 10);
      save.dailyStreak.count = save.dailyStreak.lastDate === yesterday ? save.dailyStreak.count + 1 : 1;
      save.dailyStreak.lastDate = date;
    }
  }
  // Local boards (ranked boards + the casual practice board).
  if (won || cfg.ranked) {
    platform.submitScore({
      board: cfg.board || "practice-local", dealId: cfg.dealId, seed: st.seed, ruleset: st.ruleset, contentVersion: Content.CONTENT_VERSION,
      score, assists: { undo: st.undos, hints: 0 }, durationMs: st.elapsedMs, moves: st.moves, invalid: st.invalid,
      sessionId: session.sessionId, at: new Date().toISOString(),
    });
  }
  const unlocked = checkAchievements(won);
  save.lastSnapshot = null;
  platform.persistSave();
  if (won) { audio.play("win"); render.playEvent("win"); } else audio.play("lose");
  if (stars > 0) audio.play("star");
  showResults({
    status: st.status, reason: st.terminalReason, score, moves: st.moves, invalid: st.invalid, undos: st.undos, elapsedMs: st.elapsedMs,
    dealId: cfg.dealId, ranked: cfg.ranked, mode: cfg.mode, stars, achievements: unlocked,
    nextLabel: cfg.mode === "journey" && won ? N("Next stage") : cfg.mode === "learn" ? N("Next lesson") : null,
  });
  postHighScore(cfg.ranked, score.total);
}
function showResults(r: Results): void {
  app.results = r;
  app.selection = null;
  app.screens = [];
  openScreen({ name: "results" });
  app.focusNext = r.nextLabel ? "btn-results-next" : "btn-results-retry";
  const key = r.status === "won" ? N("Deal cleared.") : r.reason === "conceded" ? N("Deal conceded.") : r.reason === "move-limit-exceeded" ? N("Out of moves.")
    : r.reason === "time-limit-exceeded" ? N("Out of time.") : N("Deal over.");
  announce(`${T(key)} ${T("Total score {n}.", { n: r.score.total })}`, true);
}
/** Signed in, every finished ranked deal posts its total to the high-score board; the results show the rank line. */
function postHighScore(ranked: boolean, total: number): void {
  app.lb = null;
  if (!ranked || !platform.signedIn()) return;
  app.lb = "posting";
  const s = app.session;
  void platform.postScore(Math.max(0, Math.round(total))).then((r) => { if (app.session === s) app.lb = r; });
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}
function unlock(key: string): Achievement | null {
  const save = platform.save();
  if (save.achievements[key]) return null;
  save.achievements[key] = new Date().toISOString();
  return Content.ACHIEVEMENTS.find((a) => a.key === key) ?? null;
}
function checkAchievements(won: boolean): Achievement[] {
  const out: Achievement[] = [];
  const save = platform.save();
  const add = (a: Achievement | null): void => { if (a) { out.push(a); audio.play("achievement"); } };
  if (won) add(unlock("first-completion"));
  if (Content.LESSONS.every((l) => save.lessons[l.id])) add(unlock("mechanic-mastery"));
  if (save.dailyStreak.count >= 3) add(unlock("daily-streak-3"));
  if (save.journey["journey-30"]) add(unlock("journey-milestone-30"));
  if (save.totals.foundations >= 2600) add(unlock("long-game"));
  return out;
}

// ------------------------------------------------------------------ lessons
function showLessonStep(): void {
  const ls = app.session ? Sess.lessonState(app.session) : null;
  if (!ls) return;
  const step = ls.def.steps[ls.stepIndex];
  if (step) announce(T("Lesson: {text}", { text: T(step.text) }));
}
export function lessonText(): string {
  const ls = app.session ? Sess.lessonState(app.session) : null;
  if (!ls) return "";
  return ls.stepIndex < ls.total
    ? T("Lesson {n}/{total}: {text}", { n: ls.stepIndex + 1, total: ls.total, text: T(ls.def.steps[ls.stepIndex]!.text) })
    : T("Lesson complete.");
}
function lessonComplete(): void {
  const cfg = app.config, session = app.session;
  if (!cfg?.lesson || !session || app.phase === "results") return;
  const save = platform.save();
  save.lessons[cfg.lesson.id] = { completedAt: new Date().toISOString() };
  platform.setOption("tutorialComplete", true);
  const newly = checkAchievements(false);
  // Lessons end on their required action, not on a full clear.
  app.phase = "results";
  const st = session.state;
  save.lastSnapshot = null;
  platform.persistSave();
  audio.play("win");
  render.playEvent("win");
  showResults({
    status: "won", reason: "lesson-complete", score: Sess.score(session), moves: st.moves, invalid: st.invalid, undos: st.undos,
    elapsedMs: st.elapsedMs, dealId: cfg.dealId, ranked: false, mode: "learn", stars: 0, achievements: newly, nextLabel: N("Next lesson"),
  });
}

// ------------------------------------------------------------------ selection and moves
function playing(): boolean { return !!app.session && app.phase === "active" && app.session.state.status === "active" && !app.screens.length; }
function movableSelection(loc: Loc, depth?: number): Selection | null {
  const st = app.session!.state;
  if (loc.zone === "cell") {
    const id = st.cells[loc.index];
    return id == null ? null : { loc, count: 1, cardIds: [id] };
  }
  if (loc.zone === "foundation") {
    const f = st.foundations[loc.index]!;
    return f.length ? { loc, count: 1, cardIds: [f[f.length - 1]!] } : null;
  }
  const col = st.tableau[loc.index]!;
  if (!col.length) return null;
  let d = depth == null ? col.length - 1 : depth;
  const runStart = col.length - Rules.orderedRunLength(col);
  if (d < runStart) d = col.length - 1; // buried card: grab the movable top
  return { loc, count: col.length - d, cardIds: col.slice(d) };
}
export function legalTargetsFor(sel: Selection | null): Loc[] {
  if (!sel || !app.session) return [];
  const seen = new Set<string>();
  return Rules.enumerateActions(app.session.state)
    .filter((a) => a.kind === "move" && a.from.zone === sel.loc.zone && a.from.index === sel.loc.index && (sel.loc.zone !== "tableau" || a.count === sel.count))
    .map((a) => a.to)
    .filter((to) => { const k = to.zone + to.index; if (seen.has(k)) return false; seen.add(k); return true; });
}
function select(sel: Selection | null, silent = false): void {
  app.selection = sel;
  app.hintAction = null;
  const targets = legalTargetsFor(sel);
  render.setSelection(sel ? sel.loc : null, sel ? sel.cardIds : []);
  render.setLegalTargets(targets);
  if (!silent && sel) audio.play("select");
  if (sel) {
    const n = sel.cardIds.length;
    const card = cardWords(sel.cardIds[0]!);
    announce(`${n > 1 ? T("Selected {card} and {n} more.", { card, n: n - 1 }) : T("Selected {card}.", { card })} ${targets.length === 1 ? T("1 legal target.") : T("{n} legal targets.", { n: targets.length })}`);
  }
}
function clearSelection(): void {
  app.selection = null;
  render.setSelection(null, []);
  render.setLegalTargets([]);
}
function deselect(): void { select(null, true); audio.play("deselect"); }
function attemptMove(from: Loc, to: Loc | null, count: number): void {
  if (!app.session || app.session.state.status !== "active") return;
  if (!to) { deselect(); render.restore(); return; }
  // Dropping a card back onto its own pile is a cancel, not an invalid attempt.
  if (from.zone === to.zone && from.index === to.index) { select(null, true); render.restore(); return; }
  const r = Sess.execute(app.session, { id: cmdId(), type: "move", from, to, count: count || 1 });
  if (r.ok) { haptic(15); clearSelection(); } else render.restore();
}
/** Shared press logic for taps, clicks and the board cursor (main.js handleCardPress). */
function handleCardPress(loc: Loc, cardId: number, depth?: number): void {
  const t = now();
  const doubleTap = app.lastTap.cardId === cardId && t - app.lastTap.at < 0.4;
  app.lastTap = { cardId, at: t };
  const sel = app.selection;
  if (sel) {
    if (sel.loc.zone === loc.zone && sel.loc.index === loc.index) {
      if (doubleTap) { smartMove(sel); return; }
      deselect();
      return;
    }
    const hit = legalTargetsFor(sel).find((x) => x.zone === loc.zone && x.index === loc.index);
    if (hit) { attemptMove(sel.loc, hit, sel.count); return; }
  }
  if (doubleTap && app.selection) { smartMove(app.selection); return; }
  const next = movableSelection(loc, depth);
  if (next) select(next);
}
/** Double tap: foundation first, then any free cell (main.js smartMove). */
function smartMove(sel: Selection): void {
  const st = app.session!.state;
  const id = sel.cardIds[sel.cardIds.length - 1]!;
  if (sel.count === 1 && Rules.canPlaceOnFoundation(st, id)) { attemptMove(sel.loc, { zone: "foundation", index: Rules.suitOf(id) }, 1); return; }
  if (sel.loc.zone === "tableau") {
    for (let i = 0; i < Rules.NUM_CELLS; i++) {
      if (i < st.constraints.cellsAvailable && st.cells[i] === null) { attemptMove(sel.loc, { zone: "cell", index: i }, 1); return; }
    }
  }
  select(null, true);
}
/** A press on a location (board cursor, slot taps): a card there, else the selection's move to it (main.js onDomCard / onDomSlot). */
export function pressLoc(loc: Loc, depth: number): void {
  if (!playing()) return;
  const st = app.session!.state;
  let id: number | null | undefined = null;
  if (loc.zone === "cell") id = st.cells[loc.index];
  else if (loc.zone === "foundation") { const f = st.foundations[loc.index]!; id = f[f.length - 1]; }
  else id = st.tableau[loc.index]![depth];
  if (id == null) { if (app.selection) attemptMove(app.selection.loc, loc, app.selection.count); return; }
  handleCardPress(loc, id, depth);
}

// ------------------------------------------------------------------ actions (HUD)
export function doUndo(): void { if (playing()) Sess.execute(app.session!, { id: cmdId(), type: "undo" }); }
export function doHint(): void {
  if (!playing()) return;
  const h = Sess.hint(app.session!);
  if (!h) { announce(T("No moves available."), true); return; }
  app.hintAction = h;
  audio.play("hint");
  render.setLegalTargets([h.to]);
  render.setSelection(h.from, []);
  const st = app.session!.state;
  const id = h.from.zone === "cell" ? st.cells[h.from.index] : h.from.zone === "foundation" ? null : Rules.topOfColumn(st, h.from.index);
  const text = T("Hint: move {card} to {zone} {n}.", { card: id != null ? cardWords(id) : T("a card"), zone: T(ZONE_WORDS[h.to.zone] ?? h.to.zone), n: h.to.index + 1 });
  announce(text);
}
export function doAuto(): void { if (playing()) Sess.execute(app.session!, { id: cmdId(), type: "auto" }); }
export function doSettle(): void { render.settle(); }
export function doPause(): void {
  if (app.phase === "active" && app.session && !app.screens.length) {
    app.phase = "paused";
    saveSnapshot();
    audio.setSuspended(true);
    openScreen({ name: "pause" });
    app.focusNext = "btn-resume";
  } else if (app.phase === "paused") {
    closeAll();
    resumeGame();
  }
}
export function resumeGame(): void {
  if (app.phase !== "paused") return;
  app.phase = "active";
  audio.setSuspended(false);
}
/** Menu: pause during a deal, else the title (main.js #btn-menu). */
export function doMenu(): void {
  if ((app.phase === "active" || app.phase === "paused") && app.session) { if (app.phase === "active") doPause(); }
  else showTitle();
}
export function askRestart(): void {
  if ((app.phase === "active" || app.phase === "paused") && app.session) openScreen({ name: "confirm", confirm: "restart" });
}
export function askConcede(): void {
  if (playing()) openScreen({ name: "confirm", confirm: "concede" });
}
export function confirmYes(kind: "restart" | "concede" | "wipe"): void {
  if (kind === "restart") { closeAll(); app.phase = "active"; audio.setSuspended(false); retryDeal(); }
  else if (kind === "concede") { closeTop(); if (app.session && app.session.state.status === "active") Sess.execute(app.session, { id: cmdId(), type: "concede" }); }
  else { platform.wipe(); app.session = null; render.clearCards(); app.phase = "title"; showTitle(); }
}
export function resetCamera(): void { render.resetCamera(); }
export function copyInvite(): void { actions.invite(); }

// ------------------------------------------------------------------ the board cursor (board-dom.js arrow navigation)
function cursorLocValid(): boolean {
  const c = app.cursor;
  if (!c || !app.session) return false;
  if (c.zone === "cell") return c.index < app.session.state.constraints.cellsAvailable;
  return true;
}
function setCursor(zone: Loc["zone"], index: number, depth = 0): void {
  const st = app.session!.state;
  if (zone === "tableau") {
    const n = st.tableau[index]!.length;
    depth = n ? Math.max(0, Math.min(n - 1, depth)) : 0;
  }
  app.cursor = { zone, index, depth };
  announce(cursorWords());
}
export function cursorWords(): string {
  const c = app.cursor, st = app.session?.state;
  if (!c || !st) return "";
  if (c.zone === "cell") {
    const id = st.cells[c.index];
    return id == null ? T("Empty cell {n}", { n: c.index + 1 }) : `${cardWords(id)}, ${T("cell {n}", { n: c.index + 1 })}`;
  }
  if (c.zone === "foundation") {
    const f = st.foundations[c.index]!;
    const fw = T(["spades foundation", "hearts foundation", "diamonds foundation", "clubs foundation"][c.index]!);
    return f.length ? `${cardWords(f[f.length - 1]!)}, ${fw}` : T("{foundation}, empty", { foundation: fw });
  }
  const col = st.tableau[c.index]!;
  return col.length ? `${cardWords(col[c.depth]!)}, ${T("column {c}, card {n} of {total}", { c: c.index + 1, n: c.depth + 1, total: col.length })}` : T("Empty column {n}", { n: c.index + 1 });
}
function moveCursor(dir: "left" | "right" | "up" | "down"): void {
  const st = app.session!.state;
  const cells = st.constraints.cellsAvailable;
  const c = app.cursor;
  if (!c || !cursorLocValid()) { const col = st.tableau[0]!; setCursor("tableau", 0, Math.max(0, col.length - 1)); return; }
  const top = (i: number): number => Math.max(0, st.tableau[i]!.length - 1);
  if (dir === "left" || dir === "right") {
    const d = dir === "right" ? 1 : -1;
    if (c.zone === "tableau") { const i = (c.index + d + 8) % 8; setCursor("tableau", i, top(i)); return; }
    if (c.zone === "cell") {
      if (d > 0) { if (c.index + 1 < cells) setCursor("cell", c.index + 1); else setCursor("foundation", 3); }
      else if (c.index > 0) setCursor("cell", c.index - 1);
      return;
    }
    // Foundations sit right to left (index 0 at the right edge).
    if (d > 0) { if (c.index > 0) setCursor("foundation", c.index - 1); }
    else if (c.index < 3) setCursor("foundation", c.index + 1);
    else setCursor("cell", Math.max(0, cells - 1));
    return;
  }
  if (c.zone === "tableau") {
    const n = st.tableau[c.index]!.length;
    if (dir === "up" && c.depth === 0) {
      if (c.index < 4) { if (c.index < cells) setCursor("cell", c.index); else setCursor("cell", Math.max(0, cells - 1)); }
      else setCursor("foundation", 7 - c.index);
    } else if (dir === "up") setCursor("tableau", c.index, c.depth - 1);
    else if (c.depth + 1 < n) setCursor("tableau", c.index, c.depth + 1);
    return;
  }
  if (dir === "down") { const i = c.zone === "cell" ? c.index : 7 - c.index; setCursor("tableau", i, top(i)); }
}

// ------------------------------------------------------------------ keys and pads (main.js keydown and gamepad)
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (app.screens.length) return; // screens handle their own keys (Escape closes the top one)
  if (a === "pause") { if (fresh()) doPause(); return; }
  if (a === "cancel") {
    if (!fresh()) return;
    if (app.selection) deselect();
    else if (app.phase === "active" && app.session) doPause();
    else if (!app.session || app.phase === "results") showTitle();
    return;
  }
  if (a === "camera_reset") { resetCamera(); return; }
  if (a === "restart") { askRestart(); return; }
  if (!playing()) return;
  if (a === "undo") doUndo();
  else if (a === "hint") doHint();
  else if (a === "auto") doAuto();
  else if (a === "nav_left" || a === "nav_right" || a === "nav_up" || a === "nav_down") {
    ui.setFocus(null);
    moveCursor(a.slice(4) as "left" | "right" | "up" | "down");
  } else if (a === "confirm") {
    if (ui.focused() !== null) return; // Enter / Space on a focused button is the button's
    if (!app.cursor || !cursorLocValid()) { moveCursor("down"); return; }
    if (render.isAnimating()) render.settle();
    pressLoc({ zone: app.cursor.zone, index: app.cursor.index }, app.cursor.depth);
  }
});

// ------------------------------------------------------------------ taps and drags on the desk (render.js pointer handling)
/** Rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: { x: number; y: number; width: number; height: number }[] = [];
/** The playfield (window pixels), set by screens.ts. */
export const view: render.ViewRect = { x: 0, y: 0, width: 0, height: 0 };
const inView = (x: number, y: number): boolean => x >= view.x && y >= view.y && x <= view.x + view.width && y <= view.y + view.height;
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
type PEvent = { kind: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number };
const events: PEvent[] = [];
let lastTouch = -1e9;
let press: { x: number; y: number; t: number; id: number; cardId: number | null } | null = null;
onTouch((e) => {
  lastTouch = now();
  if (e.control) return;
  const kind = e.phase === "start" ? "down" : e.phase === "end" ? "up" : e.phase === "move" ? "move" : "cancel";
  events.push({ kind, x: e.x, y: e.y, id: e.id });
});
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  events.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, id: -1 });
});
onPointerMove((x, y) => { if (press && press.id === -1 && now() - lastTouch >= 0.6) events.push({ kind: "move", x, y, id: -1 }); });
/** Tap / drag by distance (8 px) and, with Hold to drag, a 0.3 s hold first (render.js TAP_DIST / TAP_MS). */
function pointerInput(): void {
  const sc = frame().scale;
  for (const ev of events.splice(0)) {
    if (ev.kind === "down") {
          press = null;
      if (!playing() || !inView(ev.x, ev.y) || onHud(ev.x, ev.y)) continue;
      // Fast-forward: any press settles cosmetic animation into the exact end state.
      if (render.isAnimating()) render.settle();
      const hit = render.pick(ev.x, ev.y);
      if (!hit) continue;
      ui.setFocus(null);
      app.cursor = null;
      if (hit.kind === "card") {
        render.beginDrag(hit.cardId);
        press = { x: ev.x, y: ev.y, t: now(), id: ev.id, cardId: hit.cardId };
      } else if (app.selection) attemptMove(app.selection.loc, hit.loc, app.selection.count);
      continue;
    }
    if (!press || press.id !== ev.id) continue;
    if (ev.kind === "move") {
      if (!render.dragging()) {
        if (Math.hypot(ev.x - press.x, ev.y - press.y) <= 8 * sc) continue;
        if (platform.options.holdToDrag && now() - press.t < 0.3) continue;
        audio.play("pickup");
      }
      render.dragTo(ev.x, ev.y);
      continue;
    }
    const d = render.endDrag();
    const p = press;
    press = null;
    if (ev.kind === "cancel" || !d || !playing()) { render.restore(); continue; }
    if (d.moved) {
      const from = render.cardLocOf(d.cardId);
      const hit = render.pick(ev.x, ev.y, d.ids);
      const to = !hit ? null : hit.kind === "slot" ? hit.loc : render.cardLocOf(hit.cardId);
      if (from) attemptMove(from, to, d.ids.size); else render.restore();
    } else if (p.cardId !== null) {
      const loc = render.cardLocOf(p.cardId);
      if (!loc) continue;
      const depth = loc.zone === "tableau" ? app.session!.state.tableau[loc.index]!.indexOf(p.cardId) : undefined;
      handleCardPress(loc, p.cardId, depth);
    }
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyOptions(): void {
  render.setPalette(platform.options.colorPalette);
  if (app.session) render.setTheme(themeFor(app.config)); else render.setTheme(platform.options.theme);
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applyOptions();
  showTitle();
  app.focusNext = "btn-play";
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(() => applyOptions());
platform.onProgressMerged(() => { if (top()?.name === "title") announce(T("Progress restored from your StarHermit cloud save.")); });
onSessionEnded(() => notice(() => S("signedOut"))); // keep playing locally
onSuspend(() => {
  hidden = true;
  // Backgrounding pauses the deal (the player resumes from the pause screen).
  if (app.phase === "active" && app.session && !app.screens.length) doPause();
  else if (app.phase === "active" || app.phase === "paused") saveSnapshot();
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => { hidden = false; if (app.phase !== "paused") audio.setSuspended(false); });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(themeFor(app.session ? app.config : null), ui.preferences().highContrast, platform.options.colorPalette);
  audio.update();
  const t = now();
  if (app.toast && app.toast.until < t) app.toast = null;
  if (app.notice && app.notice.until < t) app.notice = null;
});
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
onRender(() => {
  hudRects.length = 0;
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput();
  const f = frame();
  render.update(frameDt, f.width, f.height, view);
});
