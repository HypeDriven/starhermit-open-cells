// The browser build's pure game scripts, shared with the Node tests: the
// rules engine (src/rules.js: deal, legality, supermove capacity, scoring,
// terminal reasons, hints, serialization), the versioned content
// (src/content.js: lessons, the 40 Journey stages, the Daily, challenges,
// practice difficulties, themes, achievements), the session (src/session.js:
// validated commands, undo, replay envelopes, hints, lesson steps), the save
// document and options (src/store.js), the string tables (src/locales/*.js
// through src/i18n.js) and the account strings (src/sh-strings.js), evaluated
// as classic scripts so their globals are this module's exports.
import { loadClassic } from "starhermit:script";

for (const f of [
  "src/rules.js", "src/content.js", "src/session.js", "src/store.js",
  "src/locales/en-GB.js", "src/locales/es.js", "src/locales/de.js", "src/locales/fr.js", "src/locales/pt.js", "src/locales/it.js",
  "src/i18n.js", "src/sh-strings.js",
]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export type Zone = "cell" | "foundation" | "tableau";
export interface Loc { zone: Zone; index: number }
export interface Constraints { cellsAvailable: number; moveLimit: number | null; timeLimitMs: number | null; noAuto: boolean }
export interface State {
  seed: number; dealId: string; ruleset: string; constraints: Constraints;
  cells: (number | null)[]; foundations: number[][]; tableau: number[][];
  moves: number; invalid: number; undos: number; elapsedMs: number; turn: number;
  status: "active" | "won" | "lost" | "conceded"; terminalReason: string | null;
}
export interface Par { moves: number; timeMs: number }
export interface Score { completion: number; winBonus: number; efficiency: number; timeBonus: number; invalidPenalty: number; undoPenalty: number; total: number }
export interface Action { kind: string; from: Loc; to: Loc; count: number }
export interface LessonStep { text: string; require: string | null }
export interface Lesson { id: string; title: string; intro: string; setup(): number[][]; steps: LessonStep[] }
export interface Stage {
  id: string; n: number; title: string; seed: number; constraints: Constraints; par: Par; difficulty: number;
  mastery: boolean; theme: string; tutorialFlags: string[];
}
export interface Challenge { id: string; title: string; difficulty: number; seed: number | null; description: string; constraints: Constraints; par: Par }
export interface Difficulty { id: string; title: string; description: string; constraints: Constraints }
export interface Theme {
  id: string; name: string; desk: string; deskTrim: string; cloth: string; slot: string; cardFace: string; cardBack: string;
  accent: string; suitRed: string; suitBlack: string; text: string;
}
export interface Daily { id: string; date: string; seed: number; constraints: Constraints; par: Par; ruleset: string }
export interface Achievement { key: string; title: string; description: string }
export interface SessionEvent { type: string; command?: { to?: Loc; from?: Loc; type: string }; message?: string; reason?: string; done?: boolean }
export interface Session {
  state: State; mode: string; ranked: boolean; par: Par | null; sessionId: string; undoStack: string[];
  log: unknown[]; lesson: { def: Lesson; stepIndex: number } | null; tableau: number[][] | null;
}
export interface SaveDoc {
  version: number;
  journey: Record<string, { stars: number; bestScore: number; bestMoves: number | null; completedAt: string }>;
  lessons: Record<string, { completedAt: string }>;
  dailies: Record<string, { score: number; won: boolean; completedAt: string }>;
  dailyStreak: { count: number; lastDate: string | null };
  achievements: Record<string, string>;
  totals: { foundations: number; wins: number; played: number };
  lastSnapshot: Snapshot | null;
  updatedAt: string | null;
}
export interface Config {
  mode: string; dealId: string; seed: number; constraints: Constraints; par: Par | null; ranked: boolean; board?: string;
  tableau?: number[][]; journeyStage?: Stage; lesson?: Lesson; challenge?: Challenge; theme?: string;
}
export interface Snapshot { config: Config; state: string; log: unknown[]; cmdSeq: number; lessonStep: number }
export interface BoardEntry {
  board: string; dealId: string; seed: number; ruleset: string; contentVersion: number; score: Score;
  assists: { undo: number; hints: number }; durationMs: number; moves: number; invalid: number; sessionId: string; at: string;
}
export interface Boards { boards: Record<string, BoardEntry[]> }
export interface Data { save: SaveDoc; boards: Boards }
export interface Options { theme: string; leftHanded: boolean; holdToDrag: boolean; haptics: boolean; colorPalette: string; tutorialComplete: boolean }

interface RulesApi {
  NUM_CELLS: number; NUM_COLUMNS: number; RANK_LABELS: string[]; SUIT_SYMBOLS: string[];
  suitOf(id: number): number; rankOf(id: number): number; colorOf(id: number): "red" | "black";
  hashString(s: string): number; orderedRunLength(col: number[]): number;
  enumerateActions(s: State): Action[]; canPlaceOnFoundation(s: State, id: number): boolean;
  topOfColumn(s: State, col: number): number | null;
  serialize(s: State): string; deserialize(json: string): State;
}
interface ContentApi {
  CONTENT_VERSION: number; LESSONS: Lesson[]; JOURNEY: Stage[]; CHALLENGES: Challenge[]; PRACTICE_DIFFICULTIES: Difficulty[];
  THEMES: Theme[]; ACHIEVEMENTS: Achievement[];
  dailyInfo(d?: Date): Daily; challengeSeed(c: Challenge): number; msUntilNextUtcDay(d?: Date): number;
}
interface SessionApi {
  createSession(o: Record<string, unknown>): Session;
  execute(s: Session, cmd: Record<string, unknown>): { ok: boolean; reason?: string; message?: string };
  on(s: Session, fn: (e: SessionEvent, s: Session) => void): void;
  hint(s: Session): Action | null;
  score(s: Session): Score;
  lessonState(s: Session): { def: Lesson; stepIndex: number; total: number } | null;
  exportReplay(s: Session): unknown;
}
interface StoreApi {
  emptySave(): SaveDoc; addEntry(b: Boards, e: BoardEntry): Boards;
  normalize(raw: unknown): Data; mergeData(local: unknown, remote: unknown): Data; same(a: unknown, b: unknown): boolean;
  readForeign(text: string | null): Data | null;
  PALETTES: string[]; THEME_IDS: string[]; DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[];
  pickOptions(raw: unknown): Partial<Options>; BROWSER_KEYS: string[];
}
interface I18nApi {
  LOCALES: string[];
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): void;
  lang(): string;
}
interface ShApi { LOCALES: string[]; shStrings(locale: string): Record<string, string> }

const g = globalThis as unknown as {
  OCRules: RulesApi; OCContent: ContentApi; OCSession: SessionApi; OCStore: StoreApi; OCI18n: I18nApi; OCShStrings: ShApi;
};
export const Rules = g.OCRules;
export const Content = g.OCContent;
export const Sess = g.OCSession;
export const Store = g.OCStore;
export const I18n = g.OCI18n;
export const ShStrings = g.OCShStrings;
