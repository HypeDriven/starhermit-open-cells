# Known Issues — Open Cells

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_P, 16k ctx),
alongside the game's own unit tests and its browser harnesses driven through headless Chrome.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node --test tests/rules.test.js tests/session.test.js`) | 30/30 pass, 0 failures |
| `node --check` on all modules (`src/*.js`, `server.js`, `tools/validate.js`, `tests/*.js`) | clean |
| `tests/e2e.html` (headless Chrome, served on :39408) | **FAIL** — `harness crashed — TypeError: Cannot read properties of undefined (reading 'enumerateActions')` after 3 of ~20 assertions |
| `tests/probe.html` | PASS (`PROBE PASS`) |
| `tests/probe2.html` | PASS (4/4 assertions, `PROBE2 DONE`) |
| `tests/probe3.html` | PASS (9/9 assertions, `PROBE3 DONE`) |
| Headless-Chrome boot + play-through | Boots to title, deals a practice game, undo/hint work; **0** console errors |
| Corrupt-`localStorage` sweep (8 corruptions × 3 keys, reload each time) | **FAIL** — 12 reloads raised `TypeError: Cannot read properties of undefined (reading 'length')` and the game never booted (see defect 2) |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |

`tests/e2e.mjs` does not exist; `tests/e2e.html` + `tests/e2e-driver.js` is the equivalent browser suite.

## Confirmed defects

### 1. A single malformed percent-escape in the URL path kills the server process

- **File:** `server.js:189` (`serveStatic`) — `let p = decodeURIComponent(url.pathname);`
- **Trigger:** `GET /%E0%A4%A HTTP/1.1` (any incomplete percent-escape).
- **Behaviour:** `decodeURIComponent` throws `URIError: URI malformed`. `serveStatic` is invoked
  synchronously from the request listener (`server.js:218`) with no `try`/`catch` — note the API branch
  immediately above *is* guarded (`try { handleApi(...) } catch (e) { … 500 … }`) but the static branch
  is not. The exception escapes the listener and Node terminates the process. Unauthenticated,
  single-request denial of service.
- **Expected:** malformed request paths must produce a 400/404, not take the host down.
- **Evidence:** live server on :39408 —

  ```
  response first line: (none)          # connection closed with no response
  open-cells alive: 000                # process gone
  URIError: URI malformed
      at decodeURIComponent (<anonymous>)
      at serveStatic (/home/albert/games/open-cells/server.js:189:11)
      at Server.<anonymous> (/home/albert/games/open-cells/server.js:218:7)
  ```

### 2. Any structurally-wrong save value bricks the game at boot

- **File:** `src/platform.js:99` (`loadSave`) calling `checksum` at `src/platform.js:53-56`
- **Trigger:** `localStorage['open-cells/save/v1']` holds valid JSON that is not the expected wrapper
  object — e.g. `[]`, `"x"`, `5`, `true`, or `{"v":999999}`.
- **Behaviour:**

  ```js
  var doc = readJson(SAVE_KEY, null);
  if (!doc) return { doc: emptySave(), conflict: null };
  if (doc.checksum !== checksum(doc.payload)) {
  ```

  `doc.payload` is `undefined`, and `checksum` immediately dereferences it
  (`for (var i = 0; i < str.length; i++)`), throwing `TypeError`. The throw happens *before* the
  `try`/`catch` further down, so the `'checksum-mismatch'` recovery path — which exists precisely for
  this case ("Corrupt — preserve the bytes and start clean rather than discarding") — is never reached.
  The exception propagates out of `boot()` (`src/main.js:46`), `window.__ocApp` is never assigned, the
  UI is never constructed, and the page is left showing the bare static HUD skeleton. The game is
  unusable until the player manually clears site data. `readJson` already handles unparseable text and
  absent keys, so only *valid JSON of the wrong shape* reaches this.
- **Expected:** `spec.md` §5 requires the client to "Cache … the last safe local snapshot" and the
  file's own comment promises graceful recovery; a damaged save should trigger the
  `announce('A saved progress file was damaged and has been preserved separately. Starting fresh.')`
  path at `src/main.js:48`.
- **Evidence:** headless-Chrome sweep, one key corrupted per reload with the others cleared —

  ```
  open-cells/save/v1 = []             -> ERROR   PAGEERROR: Cannot read properties of undefined (reading 'length')
                                                   at checksum   (src/platform.js:55:29)
                                                   at loadSave   (src/platform.js:99:26)
                                                   at boot       (src/main.js:46:20)
  open-cells/save/v1 = "x"            -> ERROR   (same)
  open-cells/save/v1 = {"v":999999}   -> ERROR   (same)
  open-cells/save/v1 = 5              -> ERROR   (same)
  open-cells/save/v1 = true           -> ERROR   (same)
  open-cells/settings/v1 = <any>      -> ok
  open-cells/boards/v1   = <any>      -> ok
  ```

  and the resulting page state:

  ```
  {"hasApp":"undefined","clicked":false,"session":null,"cards":0,
   "text":"Skip to the card table Open Cells Menu Pause OBJECTIVE ... Restart Co"}
  ```

  (`clicked:false` — there is no Play button, because the title screen was never rendered.)

### 3. Fabricated scores with no replay envelope top the daily leaderboard

- **File:** `server.js:76` (`validateScoreClaim`) and `server.js:151` (the board sort)
- **Trigger:** POST `/api/v1/scores` for the daily board with a correct `seed` and **no** `replay` field.
- **Behaviour:** without a replay envelope `validateScoreClaim` returns `{ ok: true, validated: false }`
  and the entry is stored with `label: 'casual'`. It is then sorted into the **same** list as validated
  entries:

  ```js
  list.sort((a, b) => (b.score.total - a.score.total) || (a.invalid - b.invalid) || …);
  ```

  so an unbacked claim outranks every genuine result. The daily seed is not a secret — the client
  derives it the same way the server does (`R.hashString('open-cells/daily/' + day)`), so the
  `seed-mismatch` gate is no obstacle. The only ceiling is `body.score.total > 50000`.
- **Expected:** `spec.md` §2 and the file's own header ("never trusts client clocks, scores, or
  completion claims") require unvalidated claims to be kept off — or at least separated from — the
  ranked board.
- **Evidence:** live server —

  ```
  submit -> 200 {"accepted":true,"validated":false,"rank":1}
  daily board: [{"s":50000,"label":"casual","sid":"qa-fabricated-1"}]
  ```

### 4. `contentVersion` is never type-checked, so a string bypasses the version gate

- **File:** `server.js:86` — `if (body.contentVersion > STALE_CONTENT_VERSION) errors.push('future-version');`
- **Trigger:** POST `/api/v1/scores` with `contentVersion: "zzz"`.
- **Behaviour:** the required-field loop only rejects `undefined`/`null`. `"zzz" > 1` coerces to `NaN > 1`
  → `false`, so the future-version check passes and the non-numeric value is stored verbatim on the
  board entry.
- **Expected:** the same `Number.isInteger` treatment given to `seed`, `moves` and `durationMs` two
  lines away.
- **Evidence:** live server —

  ```
  contentVersion "zzz" -> 200 {"accepted":true,"validated":false,"rank":2}
  contentVersion 999   -> 422 {"error":"future-version"}
  board: [... {"sid":"qa-str-ver","s":100,"cv":"zzz","label":"casual"}]
  ```

### 5. `invalid` drives the leaderboard tie-break but is never validated or defaulted

- **File:** `server.js:79` (the `req` list omits `invalid`), `server.js:145` (stored as-is),
  `server.js:151` (used in the sort)
- **Trigger:** submit a score claim without an `invalid` field — which nothing prevents.
- **Behaviour:** the entry is written with `invalid: undefined`, and the comparator computes
  `undefined - undefined` → `NaN`. A comparator returning `NaN` gives `Array.prototype.sort`
  implementation-defined behaviour, so equal-score entries can land in an arbitrary order.
- **Expected:** `spec.md` §2 — ties break by "fewer invalid actions"; the field must be a validated
  non-negative integer.
- **Evidence:** the stored board rows carry no `invalid` key at all —
  `[{"sid":"qa-fabricated-1","s":50000,"label":"casual"},{"sid":"qa-str-ver","s":100,"cv":"zzz","label":"casual"}]`
  (both `inv` values came back `undefined`).

### 6. The e2e harness reads `window.OCRules` before the game scripts have run

- **File:** `tests/e2e.html:10-22` together with `tests/e2e-driver.js:38` (`R = window.OCRules;`)
- **Trigger:** open `tests/e2e.html`.
- **Behaviour:** the harness bootstraps from `fetch('/index.html').then(...)`, which resolves while the
  parser is still blocked downloading `../vendor/three.min.js`. The driver `<script>` is therefore
  appended *before* `../src/rules.js` executes, and `run()`'s first statement captures `undefined`.
  Three assertions pass (they only touch the DOM and `window.__ocApp`, which the driver awaits) and
  then the run dies at the first engine call.
- **Expected:** the suite should complete; ~17 further assertions (legal move through the DOM board,
  undo, cell/foundation moves, keyboard input, settings round-trip, pause/resume) never execute.
- **Evidence:** harness output —

  ```
  PASS title screen shows
  PASS deal has 52 cards in tableau
  PASS dom board renders 52 card buttons
  FAIL harness crashed — TypeError: Cannot read properties of undefined (reading 'enumerateActions')
      at run (http://127.0.0.1:39408/tests/e2e-driver.js:59:18)
  E2E DONE
  ```

  and an instrumented ordering probe on the same page —

  ```
  driver-script-appended @33ms; OCRules is undefined
  OCRules-defined @70ms
  DOMContentLoaded @74ms
  ```

### 7. Concede then undo makes a legitimate session fail its own replay verification

- **File:** `src/session.js:120-127` (`execute`, concede branch) vs `src/session.js:229`
  (`validateReplay`, concede branch)
- **Trigger:** make a move, concede, then undo — all legal through the real UI in Practice.
- **Behaviour:** the two code paths keep different undo stacks. `execute` does **not** snapshot before
  a concede:

  ```js
  if (cmd.type === 'concede') {
    session.state = R.applyCommand(before, { type: 'concede' });
    session.log.push({ id: cmd.id || null, type: 'concede' });
  ```

  while `validateReplay` does:

  ```js
  if (c.type === 'concede') { stack.push(s); s = R.applyCommand(s, { type: 'concede' }); continue; }
  ```

  A live undo therefore pops the pre-*move* state while the replay's undo pops the pre-*concede*
  state, and the two runs diverge from that point on.
- **Expected:** the replay of a genuine session must reproduce it; `spec.md` §5 makes the replay
  envelope the verification mechanism, and `server.js:104` rejects submissions with
  `replay-invalid:<reason>` on exactly this signal.
- **Evidence:** driving the real module —

  ```
  concede ->                                    {"ok":true}
  undo after concede ->                         {"ok":true}
  validateReplay after concede+undo -> ok=false [{"index":-1,"reason":"final-hash-mismatch"}]
  ```

  A control run with ticks and a move validates cleanly (`ok=true`), so the divergence is specific to
  the concede/undo pairing.

### 8. First-ever achievement grant reports `already: true`

- **File:** `server.js:158-165`
- **Trigger:** POST `/api/v1/achievements` with a fresh `x-player-id` and a valid key.
- **Behaviour:** the handler correctly stores the grant only once, but the response is unconditional:
  `return send(200, { ok: true, already: true });` — the `already` flag is outside the `if (!mine[key])`
  block, so a caller can never distinguish a new unlock from a repeat.
- **Expected:** `already` should reflect whether the achievement was previously held (this is what makes
  "durable, idempotent achievement delivery", per the comment on the same line, observable).
- **Evidence:** live server with a never-seen identity → `200 {"ok":true,"already":true}`.

## Suspected — not confirmed

### 1. Static-file boundary check is a string prefix, not a path boundary

- **File:** `server.js:190` — `if (!file.startsWith(__dirname) || file.includes('.server-data'))`
- **Concern:** `__dirname` has no trailing separator, so a sibling directory whose name begins with
  `open-cells` (e.g. `open-cells-backup/`) satisfies the prefix test and would be served.
- **Why unconfirmed:** no such sibling exists here and a live `GET /../fleet-signals/spec.md` correctly
  returned 404. Creating a prefix-sharing sibling to prove it would have meant writing into `~/games`.

### 2. `validateReplay` does not apply the `noAuto` constraint to `auto` commands

- **File:** `src/session.js:231-232` vs `src/session.js:79`
- **Concern:** `execute` rejects an `auto` command when `before.constraints.noAuto` is set; the replay
  validator's `auto` branch only asks `R.findSafeAutoMoves(s).length > 0`. 18 journey stages ship with
  `noAuto: true` (`src/content.js:165` onward), so a tamperer could rewrite a logged `invalid` entry as
  an `auto` entry and the validator would not reject it on the constraint.
- **Why unconfirmed:** `R.applyCommand` itself still refuses the move under `noAuto`
  (`src/rules.js:486`, bumping `invalid` and returning the state unchanged), so the resulting hash may
  well be identical and the tamper achieves nothing. No divergent outcome could be produced.

### 3. `.server-data/` is not gitignored

- **File:** `.gitignore` (`node_modules/`, `.local-data/`, `*.log`, `.DS_Store`) vs `server.js:38`
- **Concern:** the runtime board/achievement store lands in the working tree as untracked files. The
  `.local-data/` entry looks like it was meant for this but nothing writes there.
- **Why unconfirmed:** may be an intentional deployment convention rather than an oversight.

## Checked, no defects found

- **Rules engine** (`src/rules.js`): 30 unit tests plus three browser probes cover deal generation,
  legal actions, supermove maths, safe autoplay, undo, replay envelope validation and tamper detection,
  the authoritative integer clock, lesson stepping and hint sourcing — all pass. `probe3.html`
  independently verifies terminal reason, score breakdown, stars, achievements and journey unlock.
- **Replay-backed submissions:** when a `replay` envelope *is* attached, `S.validateReplay` plus the
  `score-replay-mismatch` check make the claim authoritative. Defect 2 is specifically about the
  no-envelope path.
- **API robustness:** malformed JSON, `null`/array bodies, and wrong-typed fields on every `/api/v1/*`
  route were handled (400/422) and left the process running. Only the static-path decode (defect 1)
  crashes it.
- **Client boot and a full deal in headless Chrome** produced no console errors, including undo, hint
  and a viewport change to 420×800.
- **Settings and boards persistence** survived every corruption tried (`''`, `'{'`, `'null'`, `'[]'`,
  `'"x"'`, `'5'`, `'true'`, `'{"v":999999}'`, `' garbage'`, `'{"version":-1,"data":null'`) — only the
  save document (defect 2) is unguarded.

## Runtime data generated by this pass

Starting the server and exercising the score endpoints created `.server-data/` inside the game
directory (leaderboard / achievement JSON containing this pass's test entries). It has been left in
place for central cleanup rather than deleted.

## Not tested

- **Assertions 4-20 of the e2e suite** — blocked by defect 5. The DOM-board move path, keyboard input,
  settings round-trip and pause/resume were therefore only spot-checked manually in the browser.
- **`tools/validate.js` / `npm run validate` deal-solvability sweep** — not part of the requested
  checks; not run.
- **Three.js render correctness** (`src/render.js`): only checked for absence of runtime errors under
  SwiftShader.
- **Audio** (`src/audio.js`): headless Chrome blocks the AudioContext before a user gesture.
