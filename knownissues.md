# Known Issues — Open Cells

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_M, 16k ctx),
alongside the game's own unit tests and its browser harnesses driven through headless Chrome.

Fix pass 2026-09-04: all eight confirmed defects fixed and re-verified (see **Resolved**). Unit tests
and the browser e2e both pass.

Review pass 2026-09-07 (Kimi): six further defects fixed and re-verified (see **Resolved 2026-09-07**).
Unit tests, the browser e2e, and the content validator (`node tools/validate.js`, 55/55) all pass.
`LICENSE.md` (PolyForm Noncommercial 1.0.0) added per root instructions; `.server-data/` gitignored.

## Resolved 2026-09-07

### 1. Lesson completion emitted `lesson-step` done twice — two stacked Results dialogs — FIXED

- **Change:** `src/session.js` — `normalizeLesson` no longer emits; it returns a `completed` flag and
  each caller (`createSession`, `checkLesson`) emits exactly once. Previously the final required
  action produced two identical `done` events, so `lessonComplete()` ran twice and two Results
  overlays stacked (visible in the old e2e workaround notes).
- **Verify:** Node harness on `learn-foundations` → 2 step events, exactly 1 `done`; the e2e now
  asserts `results` overlay count === 1 on desktop and mobile.

### 2. Concede on a finished deal overwrote `won` with `lost` — FIXED

- **Change:** `src/rules.js:494` (`applyCommand`, concede branch) — a concede is only applied while
  `status === 'active'`; otherwise it counts as an invalid attempt and the terminal outcome stands.
  `src/main.js` `doConcede` also gained the same phase/status guards the other HUD actions have.
- **Verify:** Node harness — concede on a won state leaves `status: 'won'` (invalid +1); concede on
  a live deal still yields `lost / conceded`.

### 3. Dropping a card back onto its own pile counted as an invalid move — FIXED

- **Change:** `src/main.js` (`attemptMove`) — a same-location move is treated as a cancel (silent
  deselect) instead of being submitted to the engine, where it cost a turn, an invalid count and a
  score penalty for what is physically "put it back". The rules engine itself is unchanged, so
  replay semantics are untouched.
- **Verify:** browser e2e (clicks/drag paths) green; engine unit tests unchanged and green.

### 4. Mobile portrait: floating HUD rail covered and blocked the leftmost cards — FIXED

- **Change:** `css/style.css` — below 1024 px in portrait, `#rail-left` is now a static top strip
  (flex row, wraps) instead of an absolutely positioned overlay on the playfield. Landscape keeps
  the existing narrow static rail. The old e2e had to fall back to keyboard because the lesson
  cards were under the rail; it now completes them by pointer tap.
- **Verify:** e2e mobile pass (390×844) uses pointer clicks for the lesson move again; deal/move
  screenshots show every card fully visible.

### 5. Top-row slots pushed foundations off-screen on narrow boards; DOM/3D foundation order mismatch — FIXED

- **Change:** `src/board-dom.js` — empty slot buttons carry short visible labels ("Cell 1", suit
  glyph for foundations) with the full text kept in `aria-label`. `css/style.css` — `.dom-cells` /
  `.dom-foundations` share the row width (`flex: 1 1 0; min-width: 0`) and `.dom-foundations` uses
  `row-reverse` so the DOM board shows foundations in the same left-to-right order as the 3D scene
  (♣ ♦ ♥ ♠), which is also the order the board's arrow-key navigation already assumed.
- **Verify:** mobile (390 px) and desktop screenshots show all 8 top-row slots on screen; e2e green.

### 6. `GET /api/v1/boards` leaked the submitter identity — FIXED

- **Change:** `server.js` — the boards endpoint now returns a public shape with `identity`
  (player id or remote IP) stripped. Stored entries are unchanged.
- **Verify:** live server — submitted with `x-player-id: tester-1`; board response contains no
  `identity` field. Score submit/rank, 400-on-bad-escape and 404-on-traversal behavior unchanged.

### Hardening (no behavioral defect confirmed)

- `server.js` static boundary check now requires `__dirname + path.sep` (a prefix-sharing sibling
  directory can no longer satisfy the prefix test — closes the previously "suspected" item 1).
- `server.js` rate-limit bucket map prunes expired windows once it exceeds 5000 identities.
- `server.js` `implausible-score` check guards `body.score` shape explicitly (defensive; the
  earlier required-field gate already rejected null/missing scores with 422).

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node --test tests/rules.test.js tests/session.test.js`) | 30/30 pass, 0 failures |
| `npm run test:e2e` (`node tests/e2e.mjs`) | **PASS** — desktop 1280×800 and mobile 390×844, no page errors |
| `node --check` on all modules (`src/*.js`, `server.js`, `tools/validate.js`, `tests/*.js`) | clean |
| `tests/e2e.html` (legacy harness) | superseded by `tests/e2e.mjs`; the documented timing race was fixed (defect 6) so `window.OCRules` is read after boot |
| `tests/probe.html` | PASS (`PROBE PASS`) |
| `tests/probe2.html` | PASS (4/4 assertions, `PROBE2 DONE`) |
| `tests/probe3.html` | PASS (9/9 assertions, `PROBE3 DONE`) |
| Headless-Chrome boot + play-through | Boots to title, deals a practice game, undo/hint work; **0** console errors |
| Corrupt-`localStorage` sweep (8 corruptions × 3 keys, reload each time) | **PASS** — structurally-wrong saves now route to the preserve-and-recover path; game boots |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |

`tests/e2e.mjs` is the authoritative browser suite (`npm run test:e2e`). `tests/e2e.html` +
`tests/e2e-driver.js` are a legacy manual harness retained for diagnostics.

## Resolved (2026-09-04)

All eight confirmed defects from the 2026-08-20 pass were fixed with minimal, correct changes and
re-verified against the current source.

### 1. Malformed percent-escape killed the server process — FIXED

- **Change:** `server.js:189` (`serveStatic`) — wrapped `decodeURIComponent(url.pathname)` in a
  `try`/`catch` that returns HTTP 400 on `URIError` instead of throwing out of the request listener.
- **Verify:** `GET /%E0%A4%A` → `http_code=400` and the process survives; a normal
  `GET /index.html` still returns 200.

### 2. Structurally-wrong save value bricked the game at boot — FIXED

- **Change:** `src/platform.js:99` (`loadSave`) — the checksum guard now requires
  `typeof doc.payload === 'string'` before calling `checksum`, so valid JSON of the wrong shape
  (arrays, strings, numbers, booleans, unknown-version objects) falls into the existing
  `checksum-mismatch` preserve-bytes/start-clean recovery path instead of throwing on
  `doc.payload` being `undefined`.
- **Verify:** via a Node harness with an injectable `localStorage`, save values `[]`, `"x"`, `5`,
  `true`, `{"v":999999}` all return `conflict: 'checksum-mismatch'` and `emptySave()`; a valid
  save still loads with `conflict: null`. `boot()` (`src/main.js:48`) then shows the
  "preserved separately. Starting fresh." announcement.

### 3. Fabricated scores with no replay envelope topped the daily board — FIXED

- **Change:** `server.js:150` (board sort) — the comparator now leads with
  `(b.validated - a.validated)`, so validated (replay-backed) claims always rank above
  unvalidated/casual claims regardless of score. Casual entries stay on the board but are clearly
  separated from the ranked/competitive portion, matching `spec.md` §2 / §201.
- **Verify:** on a live server, a genuine validated entry with `score.total: 0` ranked **above** a
  fabricated casual claim of `score.total: 50000`:
  `validated:0 | casual:50000`, with the validated submit reporting `validated:true, rank:1`.

### 4. `contentVersion` was never type-checked — FIXED

- **Change:** `server.js:87` — added `if (!Number.isInteger(body.contentVersion))` → `bad-content-version`
  next to the existing future-version gate, matching the treatment already given to `seed`, `moves`
  and `durationMs`.
- **Verify:** `contentVersion: "zzz"` → `422 {"error":"bad-content-version"}`; an integer still
  accepts (and an oversized integer still gets `future-version`).

### 5. `invalid` drove the tie-break but was never validated or defaulted — FIXED

- **Change:** `server.js:90` — added
  `if (!Number.isInteger(body.invalid) || body.invalid < 0) errors.push('bad-invalid')`. The stored
  entry keeps `invalid` and the sort now uses `(a.invalid || 0) - (b.invalid || 0)` so legacy rows
  lacking the field can never produce `NaN` in the comparator.
- **Verify:** a score claim omitting `invalid` (or with `invalid: -2`) → `422 {"error":"bad-invalid"}`.

### 6. The e2e harness read `window.OCRules` before the game scripts ran — FIXED

- **Change:** `tests/e2e-driver.js:38` — `R = window.OCRules` is captured *after* the
  `waitFor(window.__ocApp && window.__ocApp.ui)` boot wait, so the engine reference is always
  defined when the first engine call is made. The full flow (legal move, undo, cell/foundation,
  keyboard, settings, pause/resume) can now run.
- **Note:** the primary browser suite is now `tests/e2e.mjs`; this fix repairs the legacy manual
  harness referenced by the 2026-08-20 pass.

### 7. Concede-then-undo failed its own replay verification — FIXED

- **Change:** `src/session.js:229` (`validateReplay`, concede branch) — removed the
  `stack.push(s)` that `execute` (`src/session.js:121`) never performs. Both code paths now keep the
  same undo-snapshot stack: a live undo after a concede pops the pre-*move* state and the replay's
  undo pops the same state, so the two runs stay aligned.
- **Verify:** building a real session, running `move → concede → undo`, exporting the replay and
  `validateReplay` returns `ok=true` with no mismatches (previously `final-hash-mismatch`).

### 8. First-ever achievement grant reported `already: true` — FIXED

- **Change:** `server.js:164-165` — the response now returns `already: had`, where `had` is whether
  the key already existed in the player's store *before* the (idempotent) grant.
- **Verify:** with a fresh `x-player-id`: first grant → `{"ok":true,"already":false}`, repeat →
  `{"ok":true,"already":true}`.

## Suspected — not confirmed

### 1. Static-file boundary check is a string prefix, not a path boundary — RESOLVED 2026-09-07

- **File:** `server.js` `serveStatic` — the check is now `file.startsWith(__dirname + path.sep)`,
  so a prefix-sharing sibling directory can no longer satisfy it. See Resolved 2026-09-07, Hardening.

### 2. `validateReplay` does not apply the `noAuto` constraint to `auto` commands

- **File:** `src/session.js:231-232` vs `src/session.js:79`
- **Concern:** `execute` rejects an `auto` command when `before.constraints.noAuto` is set; the replay
  validator's `auto` branch only asks `R.findSafeAutoMoves(s).length > 0`. 18 journey stages ship with
  `noAuto: true`, so a tamperer could rewrite a logged `invalid` entry as an `auto` entry.
- **Why unconfirmed:** `R.applyCommand` itself still refuses the move under `noAuto`
  (`src/rules.js:486`), so the resulting hash is identical and the tamper achieves nothing.
- **Decision:** left as-is; no divergent outcome exists.

### 3. `.server-data/` is not gitignored — RESOLVED 2026-09-07

- **File:** `.gitignore` now includes `.server-data/`, so the runtime board/achievement store can no
  longer be committed accidentally.

## Checked, no defects found

- **Rules engine** (`src/rules.js`): 30 unit tests plus three browser probes cover deal generation,
  legal actions, supermove maths, safe autoplay, undo, replay envelope validation and tamper detection,
  the authoritative integer clock, lesson stepping and hint sourcing — all pass. `probe3.html`
  independently verifies terminal reason, score breakdown, stars, achievements and journey unlock.
- **Replay-backed submissions:** when a `replay` envelope *is* attached, `S.validateReplay` plus the
  `score-replay-mismatch` check make the claim authoritative. The no-envelope path is now separated
  in ranking (see Resolved defect 3). `validateScoreClaim` is still under review for the `auto`
  `noAuto` nuance (Suspected 2).
- **API robustness:** malformed JSON, `null`/array bodies, and wrong-typed fields on every `/api/v1/*`
  route are handled (400/422) and leave the process running. The static-path decode is now also
  guarded (Resolved defect 1).
- **Client boot and a full deal in headless Chrome** produced no console errors, including undo, hint
  and a viewport change to 420×800.
- **Settings and boards persistence** survived every corruption tried (`''`, `'{'`, `'null'`, `'[]'`,
  `'"x"'`, `'5'`, `'true'`, `'{"v":999999}'`, `' garbage'`, `'{"version":-1,"data":null'`) — and, since
  this fix pass, the save document too (Resolved defect 2).

## Runtime data

The 2026-08-20 pass created `.server-data/` inside the game directory. Verification for this fix pass
used ephemeral `OPEN_CELLS_DATA` dirs under `/tmp`, so no new runtime data was written into the
working tree; the pre-existing `.server-data/` is left for central cleanup (see Suspected 3).

## Not tested

- `tools/validate.js` — RUN 2026-09-07: 55/55 content items proven (lessons, journey, challenges,
  dailies).
- Three.js render correctness (`src/render.js`): only checked for absence of runtime errors under
  SwiftShader.
- Audio (`src/audio.js`): headless Chrome blocks the AudioContext before a user gesture.
