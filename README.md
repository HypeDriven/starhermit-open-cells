# Open Cells

An open-information card puzzle on a brass-and-slate strategy desk. Four
temporary cells, a fully visible eight-column tableau, four suit foundations.
Everything is deterministic and inspectable: every deal has a seed, every
result a replayable command log.

## Run

- **Offline:** open `index.html` in any modern browser, or serve the folder
  (`python3 -m http.server`, or `node server.js`).
- **Hosted (StarHermit-style):** `starhermit.txt` declares `launch=index.html`
  and `server=server.js`. The authoritative script serves the static files and
  a small `/api/v1` surface (time sync, replay-validated leaderboards, durable
  idempotent achievements, presence, activity, allow-listed telemetry).
  `PORT` selects the port (default 8787); server data lives in `.server-data/`
  (gitignore-worthy, not part of the distribution).

## Play

- Build all four foundations from ace to king.
- Columns build downward in alternating colors; ordered runs move together.
- A run you may move is at most `(free cells + 1) × 2^(empty columns)` long.
- Controls: drag or tap-to-select/tap-target, double-tap for a smart move;
  keyboard arrows + Enter/Space, `Z` undo, `H` hint, `A` collect, `Esc` pause;
  gamepad D-pad + A/B/Start.

## Modes

Learn (6 interactive lessons), Journey (40 authored, solver-validated stages),
Daily (one immutable UTC seed), Practice (three difficulties, unranked),
Challenge (constrained deals), Score Chase (seeded boards). Progress,
settings, boards, and achievements persist locally in a versioned,
checksummed save document.

## Architecture

- `src/rules.js` — pure deterministic engine: legality, supermove capacity,
  scoring breakdown, terminal reasons, serialization, seeded RNG.
- `src/session.js` — validated commands, undo, replay envelopes, hints (same
  legal-action API as play), lesson tracking.
- `src/content.js` — versioned lessons/stages/daily/challenges/themes.
- `src/render.js` — Three.js desk scene (procedural geometry, canvas-texture
  cards, PBR lighting, pooled particles, quality tiers, context recovery).
- `src/board-dom.js` — semantic, fully playable HTML board (accessibility
  layer and no-WebGL fallback).
- `src/ui.js` — screens, HUD, focus management, live regions, settings.
- `src/platform.js` — persistence, leaderboards, platform time sync (signed in only).
- `src/audio.js` — procedural WebAudio on music/effects/ambience/voice buses.
- `src/main.js` — app state machine and orchestration.
- `server.js` — authoritative hosted script (also a standalone static server).

## Tests and validation

- `node --test tests/rules.test.js tests/session.test.js` — engine and session
  unit tests (legality, invalid reasons, scoring, terminal states,
  serialization, replay determinism, fuzzing).
- `node tools/validate.js` — offline content proof: every lesson's required
  actions are performable and every deal seed is solver-proven (`--rescue`
  finds replacement seeds for any unproven deal).
- `tests/e2e.html` — browser end-to-end harness driving the real UI
  (serve the folder, open `/tests/e2e.html`; results in the console).
