// Localization: the engine's string tables (assets/strings.json: the nine
// StarHermit locales, US-English text as the key) in the interface language the
// runtime reports (the player's choice in Options › Language, else the account's
// preferred language or the device's). The runtime's Options replaced the game's
// Language setting (sh-language.js) and the DOM re-labelling: every string is
// drawn through T() each frame, so a change shows on the next frame. The account
// lines are the engine's `starhermit.*` keys.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { Rules } from "./classic.ts";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  const k = String(key ?? "");
  if (strings.has(k)) return strings.t(k, vars ?? undefined);
  return vars ? k.replace(/\{(\w+)\}/g, (m, n: string) => (vars[n] != null ? String(vars[n]) : m)) : k;
}
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** An account line: the engine's `starhermit.*` strings (signIn, invite, inviteCopied, inviteFailed, signedOut, leaderboardPosting, leaderboardRank, leaderboardPosted, leaderboardNotPosted). */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }

const SUIT_WORDS = [N("spades"), N("hearts"), N("diamonds"), N("clubs")];
const RANK_WORDS = [N("ace"), N("two"), N("three"), N("four"), N("five"), N("six"), N("seven"), N("eight"), N("nine"), N("ten"), N("jack"), N("queen"), N("king")];
export const FOUNDATION_WORDS = [N("spades foundation"), N("hearts foundation"), N("diamonds foundation"), N("clubs foundation")];
/** Spoken card name in the game language ("six of spades"; board-dom.js cardWords). */
export function cardWords(id: number): string {
  return T("{rank} of {suit}", { rank: T(RANK_WORDS[Rules.rankOf(id) - 1]!), suit: T(SUIT_WORDS[Rules.suitOf(id)]!) });
}
/** m:ss (ui.js fmtTime). */
export function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
/** ui.js fmtDuration. */
export function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? T("{h}h {m}m", { h, m }) : T("{m}m", { m });
}
