// Localization: the browser build's string tables (src/locales/*.js through
// src/i18n.js: the nine StarHermit locales, US-English text as the key) and
// the account-control strings (src/sh-strings.js), in the interface language
// the runtime reports (preferences().language: the player's choice in
// Options › Language, else the account's preferred language or the device's).
// The runtime's Options replaced the game's Language setting (sh-language.js)
// and the DOM re-labelling: every string is drawn through T() each frame, so a
// change shows on the next frame.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { I18n, Rules, ShStrings } from "./classic.ts";

const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region; es-MX → es-419). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US");
  const exact = I18n.LOCALES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const lang = s.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|uk|ie|au|nz|za|in)$/i.test(s)) return "en-GB";
  if (lang === "es" && /-es$/i.test(s)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(s)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "";
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  I18n.setLocale(next);
  locale = I18n.lang();
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));
export function currentLocale(): string { return locale; }

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return I18n.T(key, vars ?? null); }
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** The account controls' strings (signIn, invite, copied, copyFailed, signedOut, lbPosting, lbRank, lbPosted, lbNotPosted). */
export function S(key: string, vars?: Vars): string {
  let s = ShStrings.shStrings(locale)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

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
