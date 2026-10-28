// The game's data and the StarHermit platform, on the runtime's modules
// (what src/platform.js did over the JS SDK):
// - the save (starhermit:storage `saves`, on the device and in the player's
//   cloud slot) is { save, boards } (src/store.js): the progress document and
//   the local personal-best boards the browser build kept in localStorage and
//   mirrored to game:<slug>; two devices' saves merge on a conflict through
//   store.js mergeData (the browser build's mergeSaves + mergeBoards); the
//   slot the browser build wrote (the JS SDK's saveJSON) shows as foreign: it
//   is merged in and replaced once;
// - the game's own options (table theme, left-handed tray, hold to drag,
//   haptics, suit colour palette, tutorial complete) are engine `settings`
//   (same keys, synced with the account); the browser build's values in the
//   account's settings KV are adopted (unless set here since), then all its
//   KV keys are removed (volumes, mute, graphics, reduced motion, contrast,
//   text size and language are the runtime's Options);
// - the player, the invite link, the platform's clock for the Daily, posting a
//   finished ranked deal's total through score-script.js (a practice session
//   whose socket carries { type: 'result', scores }, as the JS SDK's
//   submitScores did) with the rank, and the board's top ten for Scores.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import { Store, type BoardEntry, type Data, type Options, type SaveDoc } from "./classic.ts";

type Key = keyof Options;

// --- the game's options --------------------------------------------------------------------
export const options: Options = JSON.parse(JSON.stringify(Store.DEFAULT_OPTIONS)) as Options;
const listeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { listeners.add(fn); }
function changed(): void { for (const fn of listeners) fn(); }
function readOption(key: Key): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = Store.pickOptions({ [key]: v })[key];
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends Key>(key: K, value: Options[K]): void {
  if (JSON.stringify(options[key]) === JSON.stringify(value)) return;
  options[key] = value;
  try { store.set(key, value as unknown as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  changed();
}
/** A migrated value, kept unless this game set the key since. */
function adoptOption(key: Key, value: unknown): void {
  const v = Store.pickOptions({ [key]: value })[key];
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v as unknown as JsonValue);
    (options as unknown as Record<string, unknown>)[key] = v;
    changed();
  } catch { /* keep the device's */ }
}
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const k of keys) if ((Store.OPTION_KEYS as string[]).includes(k)) adoptOption(k as Key, store.legacy(k));
  for (const k of keys) if (Store.BROWSER_KEYS.includes(k)) store.removeLegacy(k);
}

// --- the save ------------------------------------------------------------------------------
let data: Data = Store.normalize(null);
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

function persist(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(data as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** The progress document (live; change it, then persistSave()). */
export function save(): SaveDoc { return data.save; }
/** platform.js persistSave: stamps and saves the progress. */
export function persistSave(): void {
  data.save.updatedAt = new Date().toISOString();
  persist();
}
/** platform.js submitScore: a finished deal's entry on its local board. */
export function submitScore(entry: BoardEntry): void {
  data.boards = Store.addEntry(data.boards, entry);
  persist();
}
/** A local board's entries, best first. */
export function getBoard(name: string): BoardEntry[] { return (data.boards.boards[name] ?? []).slice(); }
/** Settings › Erase local progress: an empty save on the device and in the account. */
export function wipe(): void {
  data = Store.normalize(null);
  persist();
}

/** Merges another document into the live one; whether anything changed (then saved). */
function adopt(other: unknown): boolean {
  const next = Store.mergeData(data, other);
  if (Store.same(next, data)) return false;
  data = next;
  persist();
  return true;
}
saves.onConflict((mine, remote) => ({ merged: Store.mergeData(mine?.data ?? null, remote.data) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud progress and boards: merged with this device's, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = Store.readForeign(old.text);
  let grew = false;
  if (doc) {
    const next = Store.mergeData(data, doc);
    grew = !Store.same(next, data);
    data = next;
  }
  persist({ replaceForeign: true });
  if (grew) merged();
}

/** For the top bar's sync line: local (a guest) | syncing | saving | synced | offline. */
export function syncState(): "local" | "syncing" | "saving" | "synced" | "offline" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign") return "syncing";
  if (st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  data = Store.normalize(cur?.data ?? null);
  for (const k of Store.OPTION_KEYS) readOption(k);
  store.onChange((k) => {
    if (!(Store.OPTION_KEYS as string[]).includes(k)) return;
    readOption(k as Key);
    changed();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  changed();
  refreshPlayer();
  void serverTime().then(() => { synced = true; }, () => undefined);
}

// --- the player and the clock ------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

let synced = false;
/** Whether the platform's clock answered (the Daily's boundary follows it, else the device's). */
export function clockSynced(): boolean { return synced; }
/** Now by the platform's clock when it has answered, else the device's (the Daily's day). */
export function now(): Date {
  let ms = Date.now();
  try { ms = serverNow() ?? ms; } catch { /* device clock */ }
  return new Date(ms);
}

// --- the high-score board ----------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Posted { posted: boolean; rank: number | null }
export interface Row { rank: number; name: string; score: number }

/** Signed in only: post a finished ranked deal's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}

export interface Hosted { entries: Row[]; me: { rank: number | null; score: number | null } | null }
/** Scores' StarHermit leaderboard: the board's top ten and the player's best; null when unavailable (platform.js getHostedLeaderboard). */
export async function hostedLeaderboard(): Promise<Hosted | null> {
  const me = player();
  if (!me) return null;
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return {
      entries: r.items.slice(0, 10).map((e, i) => ({ rank: e.rank ?? i + 1, name: e.displayName || e.username || "", score: Number.isFinite(e.score) ? e.score : 0 })),
      me: mine ? { rank: mine.rank ?? null, score: Number.isFinite(mine.score) ? mine.score : null } : null,
    };
  } catch { return null; }
}
