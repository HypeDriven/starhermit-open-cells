# Known Issues — Open Cells

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_M, 16k ctx),
alongside the game's own unit tests and its browser harnesses driven through headless Chrome.

Fix pass 2026-09-04: all eight confirmed defects fixed and re-verified (see **Resolved**). Unit tests
and the browser e2e both pass.

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

### 1. Static-file boundary check is a string prefix, not a path boundary

- **File:** `server.js:190` — `if (!file.startsWith(__dirname) || file.includes('.server-data'))`
- **Concern:** `__dirname` has no trailing separator, so a sibling directory whose name begins with
  `open-cells` (e.g. `open-cells-backup/`) satisfies the prefix test and would be served.
- **Why unconfirmed:** no such sibling exists here and a live `GET /../fleet-signals/spec.md` correctly
  returned 404. Creating a prefix-sharing sibling to prove it would have meant writing into `~/games`.
- **Decision:** left as-is; not a reproducible defect in the current tree.

### 2. `validateReplay` does not apply the `noAuto` constraint to `auto` commands

- **File:** `src/session.js:231-232` vs `src/session.js:79`
- **Concern:** `execute` rejects an `auto` command when `before.constraints.noAuto` is set; the replay
  validator's `auto` branch only asks `R.findSafeAutoMoves(s).length > 0`. 18 journey stages ship with
  `noAuto: true`, so a tamperer could rewrite a logged `invalid` entry as an `auto` entry.
- **Why unconfirmed:** `R.applyCommand` itself still refuses the move under `noAuto`
  (`src/rules.js:486`), so the resulting hash is identical and the tamper achieves nothing.
- **Decision:** left as-is; no divergent outcome exists.

### 3. `.server-data/` is not gitignored

- **File:** `.gitignore` (`node_modules/`, `.local-data/`, `*.log`, `.DS_Store`) vs `server.js:38`
- **Concern:** the runtime board/achievement store lands in the working tree as untracked files. The
  `.local-data/` entry looks like it was meant for this but nothing writes there.
- **Why unconfirmed:** may be an intentional deployment convention rather than an oversight.
- **Decision:** left as-is.

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

- `tools/validate.js` / `npm run validate` deal-solvability sweep — not part of the requested checks;
  not run.
- Three.js render correctness (`src/render.js`): only checked for absence of runtime errors under
  SwiftShader.
- Audio (`src/audio.js`): headless Chrome blocks the AudioContext before a user gesture.
