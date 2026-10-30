# Open Cells

An open-information card puzzle on a brass-and-slate strategy desk. Four
temporary cells, a fully visible eight-column tableau, four suit foundations.
Everything is deterministic and inspectable: every deal has a seed, every
result a replayable command log.

A StarHermit engine script game (engine 1.29.0, `engine.minor=31`): played
natively by the StarHermit client and in browsers by the engine's web runtime
(`index.html` is the engine's loader, written by `npm run package`).

## Run

- **Native:** `starhermit .` in this folder (the published runtime, e.g.
  `~/sh/runtime/1.29.0/starhermit-1.29.0-linux-x86_64/starhermit`).
- **Browser:** serve the folder (`python3 -m http.server`) and open it; the
  loader fetches the pinned engine.
- `starhermit.txt` declares the manifest, `server=score-script.js` (the
  platform script that posts finished ranked deals to the high-score board)
  and every control.

## Play

- Build all four foundations from ace to king.
- Columns build downward in alternating colors; ordered runs move together.
- A run you may move is at most `(free cells + 1) × 2^(empty columns)` long.
- Controls: drag, or tap to select and tap the target, double-tap for a smart
  move; keyboard arrows (board cursor) + Enter/Space, `Z` undo, `H` hint,
  `A` collect, `R` restart, `P`/`Esc` pause, `0` camera; gamepad D-pad +
  A/B/Start and more (rebind in the runtime's Options).

## Modes

Learn (6 interactive lessons), Journey (40 authored, solver-validated stages),
Daily (one UTC seed), Practice (three difficulties, unranked), Challenge
(constrained deals), Score Chase (seeded boards). Progress, boards and
achievements live in the engine save (device + cloud when signed in).

## Architecture

- `src/rules.js`, `src/session.js`, `src/content.js`, `src/store.js` — the pure
  game (shared with the Node tests).
- `native/*.ts` — the engine client: `main.ts` (state machine, input),
  `screens.ts` (UI), `render.ts` (3D desk), `audio.ts`, `platform.ts`,
  `quality.ts`, `i18n.ts`, `style.ts`.
- `spec.md` — the running spec.

## Tests

- `npm test` — unit tests (`node --test`) and `tests/native.mjs` (tsc,
  `starhermit check`, the `tests/native/*.play` render checks).
- `npm run test:browser` — the packaged game in GPU Chrome at desktop, phone
  and landscape.
- `npm run validate` — offline content proof (solver).
- After any change: `npm run package` (and `npm run plays`, `npm run css`,
  `npm run textures` when their inputs change).
