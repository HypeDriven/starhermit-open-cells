# Open Cells — Game Design Document (running spec)

**Status:** running spec. It describes what the shipped game does today, in present tense.
Anything the design wants but the code does not do yet is confined to "Design intent not yet
implemented" at the end.

---

## 1. Overview

**Pitch.** Every card is face up from the first second. Four brass-lipped cells are the only place
to put a card that has nowhere to go — Open Cells is the puzzle of spending those four slots well.

| | |
|---|---|
| Genre | Open-information solitaire / deterministic card puzzle |
| Players | 1, with asynchronous score comparison |
| Session | 2 min (a Learn lesson) to ~10 min (a full deal) |
| Platforms | Desktop and mobile browsers, portrait and landscape |
| Rendering | Three.js desk scene (`vendor/three.min.js`) over a fully playable semantic HTML board; the HTML board is the fallback and the accessibility surface |
| Persistence | `localStorage`, versioned + checksummed |
| Networking | Optional `/api/v1/*` on the StarHermit host; fully playable offline |

### File map

| Path | Responsibility |
|---|---|
| `index.html` | Shell: topbar, left objective rail, playfield (`#scene` canvas + `#dom-board`), right action rail, bottom tray, `#screens` overlay host, two live regions. |
| `css/style.css` | Layout, five themes, colour-blind palettes, responsive rules, DOM-board styling, key-art backdrops. |
| `src/rules.js` | Pure engine: deal, legality, supermove capacity, safe autoplay, scoring, terminal reasons, hashing, seeded RNG. No DOM. |
| `src/session.js` | Validated commands, undo snapshots, replay envelope + `validateReplay`, hints, lesson tracking, event emission. |
| `src/content.js` | 6 lessons, 40 journey stages, 6 challenges, 3 practice difficulties, daily derivation, 5 themes, 5 achievements. |
| `src/render.js` | Three.js scene: procedural desk geometry, canvas-drawn card and surface textures, image-based lighting, post-processing chain, Graphics settings (`setGraphics`, `graphicsInfo`), adaptive resolution, pooled particles and dust motes, context-loss recovery, raycast intents. |
| `src/gfx.js` | Pure graphics quality model (no three.js): presets, per-category tiers, GPU-based Auto detection, `resolve()`, `presetTier()`, `choosePreset()`, `describe()`, and the Graphics panel strings in nine locales. |
| `vendor/three/` | `three-global.js` (ES-module view of the vendored r152 `window.THREE`) and same-revision addons (`addons/postprocessing`, `addons/shaders`, `addons/environments/RoomEnvironment.js`), loaded on demand through the import map in `index.html`. |
| `src/board-dom.js` | The HTML board — real `<button>` cards and slots, arrow-key navigation, ARIA labels. |
| `src/ui.js` | 14 overlay screens, focus trap and restore, HUD, live-region announcements, settings form. |
| `src/platform.js` | Launch-token handling, settings, save document, local boards, read-only hosted leaderboard, profile nickname, cloud-save mirror, dev-server time sync/telemetry. |
| `src/audio.js` | Four buses, authored one-shots from `sfx/`, procedural fallbacks, adaptive pad. |
| `src/main.js` | App state machine, input routing, tick loop, results and progression bookkeeping. |
| `server.js` | Authoritative host script and standalone static server. |
| `tools/validate.js` | Offline solver proving lessons and every shipped deal seed. |
| `tests/` | `rules.test.js`, `session.test.js`, `gfx.test.js` (37 `node --test` cases), `e2e.mjs` (Playwright), legacy `*.html` probes. |
| `tools/shots.mjs` | Visual check: title and in-game screenshots at a forced graphics preset, desktop and mobile, into `test-results/`. |
| `sfx/` | 15 Opus clips + `manifest.txt` (canonical), `manifest.json` (generator), `manifest.md`. |
| `assets/` | Authored key art and textures (§8). |

---

## 2. Design pillars

**1. Nothing is hidden — the difficulty is arithmetic, not luck.**
Rules in: every card face up from the deal; the seed printed in the HUD; the capacity formula
stated out loud in the Supermoves lesson and in the invalid-move message. Rules out: face-down
stock piles, draw decks, per-run random events, and any "you couldn't have known that" loss.

**2. Four cells are a budget you spend.**
Rules in: constraints that vary only the budget (`cellsAvailable` 2–4) as the primary difficulty
axis; a capacity of `(free cells + 1) × 2^(empty columns)` that makes an occupied cell physically
shorten every future run. Rules out: consumables, boosters, or extra cells as a reward.

**3. The desk is furniture, not spectacle.**
Rules in: a static camera on a lit brass-and-slate desktop, cards that slide rather than fly, a
particle burst reserved for a win. Rules out: camera flights, screen shake as feedback for ordinary
moves, and any effect whose removal (reduced motion, low quality, HTML mode) would hide state.

**4. Two boards, one truth.**
Rules in: the DOM board renders the same `state` object as the 3D scene and shares one press
handler (`handleCardPress`); either can complete any deal; the e2e drives the DOM board. Rules out:
canvas-only affordances such as hover-only previews or drag-only moves.

**5. A result you can prove.**
Rules in: integer scores, a component breakdown on the results screen, a replay envelope attached
to every ranked submission, and a server that ranks validated claims above unvalidated ones.
Rules out: wall-clock scoring the client can fudge, and secret tie-breaks.

---

## 3. Player experience

**Target player.** Someone who already knows a free-cell-style patience game and wants a tidy,
quiet, unrandomised version of it — plus a curious newcomer the Learn track can carry.

**First 60 seconds.** Boot lands on the title overlay over the desk key art, with Play the dominant
button and `Learn` one row below. On a small screen (`min(screen.width, screen.height) < 760`) the
game defaults to the HTML board, so the first tap is on a real button either way.

- 0–5 s: title reads the pitch line — "Four cells. Fifty-two cards. No hidden information."
- 5–15 s: Play deals a standard practice board; the deal cue plays; the left rail states the
  objective ("Build all four foundations, ace to king.") and the live region announces it with the
  deal id.
- 15–40 s: first tap selects a card and every legal destination lights up (`legal-target`), so the
  rules are taught by highlight before they are read. An illegal drop toasts the engine's own
  sentence ("Columns build downward in alternating colors.") rather than a buzz.
- 40–60 s: `Hint` names a ranked legal move in text and highlights it on both boards; `Collect`
  sweeps every provably safe card home. A player who wants the rules first takes Learn, whose six
  lessons each require the player to actually perform the move before advancing.

**Session shape.** Open → choose a mode → one deal (5–10 min) → results with the score breakdown,
stars and any achievement → "next" recommendation (next journey stage, or a re-deal). Leaving
mid-deal saves a snapshot; the title button becomes **Continue**.

**Emotional beat.** The moment a long ordered run becomes movable because you finally emptied a
column — capacity doubling from 5 to 10 — and four turns of pressure release at once.

---

## 4. Core loop and rules contract

Owner of every rule below: `src/rules.js`, unless stated. The engine never mutates its input and
never touches DOM or wall-clock.

### Board

- 52 cards as integers 0..51, `id = suit*13 + (rank-1)`; suits 0 ♠, 1 ♥, 2 ♦, 3 ♣; ranks 1(A)..13(K).
  Red = hearts/diamonds (`colorOf`).
- 8 tableau columns dealt round-robin from a mulberry32 shuffle (`deal(seed)`): columns 0–3 get 7
  cards, 4–7 get 6.
- 4 cells (`state.cells`), of which `constraints.cellsAvailable` are usable.
- 4 foundations, one per suit, built A→K.
- Locations are `{ zone: 'cell'|'foundation'|'tableau', index }`.

### Legal actions (`enumerateActions`, `validateMove`)

| Move | Legality |
|---|---|
| tableau top → cell | cell index `< cellsAvailable` and empty; exactly one card. |
| cell → foundation, tableau top → foundation | same suit and `rank === foundation.length + 1`. |
| foundation → anywhere | allowed: the ruleset is undo-friendly, one card at a time (`pickCards`). |
| card/run → non-empty column | head is one rank lower and opposite colour to the destination top. |
| card/run → empty column | always legal, except relocating a whole column unchanged (`pointless-move`). |
| run of length n → column | run must be descending and alternating (`isOrderedSequence`) and `n ≤ maxMovableSequence`. |
| `auto` (Collect) | offered when `findSafeAutoMoves` is non-empty and `constraints.noAuto` is false. |
| `concede` | only while `status === 'active'`. |

**Capacity.** `maxMovableSequence(s, dest) = (freeCells + 1) × 2^(emptyColumns excluding dest)`.
**Safe card.** `isSafeForFoundation`: rank ≤ 2, or both opposite-colour foundations already hold
rank − 1 — so the card can never be needed as a landing spot. `Collect` cascades to a fixpoint in a
deterministic order (cells left-to-right, then columns left-to-right, repeated).

### Resolution order (`applyCommand`)

`tick` commands add integer ms to `elapsedMs`, re-check terminal, and consume no turn (they are
excluded from replay logs). Every other command bumps `turn` by 1. A rejected command increments
`invalid` and returns a new state — rejection is a recorded outcome, not an exception. `undo` is
resolved by `session.js` (it owns the snapshot stack); the engine only counts it so scoring stays
honest. After a successful move `updateTerminal` runs.

**Terminal states.** `won / all-foundations-complete` (52 home) · `lost / move-limit-exceeded`
(`moves >= constraints.moveLimit`) · `lost / time-limit-exceeded` (`elapsedMs >= timeLimitMs`) ·
`lost / conceded`. There is no dead-end detection: a board with no legal move stays `active` until
the player concedes.

### Scoring (`scoreBreakdown`)

```
completion     = cardsHome × 100
winBonus       = won ? 5000 : 0
efficiency     = won ? max(0, par.moves - moves) × 25 : 0
timeBonus      = won ? floor((par.timeMs - elapsedMs) / 1000) × 2 : 0
invalidPenalty = -invalid × 10
undoPenalty    = -undos × 5
```

*Worked example* — daily deal (par 120 moves / 360 000 ms), won in 96 moves and 4:00 with 3 invalid
attempts and 5 undos: `5200 + 5000 + 600 + 240 − 30 − 25 = 10 985`.

**Tie-breaks** (`compareResults`, mirrored in `server.js`): completion desc, then fewer invalid,
then lower `elapsedMs`, then `sessionId` string order. The server prepends one more key: validated
(replay-backed) entries outrank unvalidated ones regardless of score.

### RNG and determinism

Seeds are 32-bit. Journey and challenge seeds are baked constants (solver-proven). Daily seeds are
`hashString('open-cells/daily/' + isoUtcDate)` — derivable, immutable, identical for every player.
Score-chase seeds are `hashString('open-cells/chase/' + typedString)`. `stateHash` is FNV-1a over
`[cells, foundations, tableau, turn, moves, invalid, status]`.

### Undo, hints, replay (`src/session.js`)

Undo keeps up to 500 serialized snapshots; each undo pops one and counts against the score. Hints
call `rankHints` — the same enumeration play uses — preferring foundation moves (100), then
productive tableau moves (50 + count), then column-emptying moves (30 + count), then cell parking
(10). `exportReplay` emits `{schema, dealId, seed, ruleset, constraints, tableau, initialHash,
commands, finalHash}`; `validateReplay` re-executes it and reports the first mismatching index.
Commands carry ids, so a duplicate id is rejected as `duplicate-command`.

---

## 5. Modes and progression

| Mode | Content | Ranked | Differences |
|---|---|---|---|
| Learn | 6 lessons (`LESSONS`) | no | Hand-built 52-card positions with the teaching cards on top; each step names a required action (`move-to-tableau`, `move-to-cell`, `move-from-cell`, `move-to-foundation`, `move-sequence`, `auto`) and only that action advances it. |
| Journey | 40 stages, 4 arcs of 10 | yes | Difficulty comes from pars first, then constraints introduced one at a time: clocks (11–14), 3 cells (15–20), move limits and `noAuto` (21–30), 2 cells combined with everything (31–40). Every 10th stage is a mastery check. Stage *n* unlocks when *n−1* is complete. |
| Daily | one UTC deal | yes | Standard rules, par 120 moves / 6:00. The title shows the deal id and the countdown to the next one; a streak is tracked in the save. |
| Practice | Relaxed / Standard / Strict | no | Relaxed and Standard are the classic desk; Strict is 3 cells and no Collect. Restart and undo are free. |
| Challenge | 6 constrained deals | yes | Fixed rulesets with baked seeds (Two Drawers, The Strict Ledger, The Brass Clock, Bare Hands, Cramped and Counted, The Brass Ordeal). |
| Score Chase | player-typed seed string | yes | Standard rules on a derived seed, compared on the boards. |

**Stars** (Journey only): 1 for winning, +1 for `moves ≤ par.moves`, +1 for `elapsedMs ≤ par.timeMs`.
Stars and best score are kept as maxima, best moves as a minimum.

**Achievements** (`ACHIEVEMENTS`, granted idempotently in `checkAchievements`): `first-completion`,
`mechanic-mastery` (all six lessons), `daily-streak-3`, `journey-milestone-30`, `long-game`
(2 600 cards sent home lifetime).

**Content validation.** `node tools/validate.js` proves every lesson's required action is performable
and every shipped seed is solvable; `--rescue` searches replacement seeds for an unproven deal.

---

## 6. Controls and interaction

| Input | Desktop | Mobile | Result |
|---|---|---|---|
| Select | Click a card / focus it and press Enter | Tap | Selection set; every legal destination gains `legal-target`; `select` cue. |
| Cancel | Click the selection again, `Esc`, gamepad B | Tap the selection | Deselect + `deselect` cue. |
| Move | Click a highlighted target, or drag on the canvas | Tap target, or drag | `attemptMove`; on success `drop`/`cell`/`foundation` cue + a 15 ms haptic pulse. |
| Smart move | Double-click | Double-tap (< 400 ms, same card) | Foundation if legal, else the first free cell. |
| Return to origin | Drop on the source pile | same | Treated as a cancel: no turn, no invalid, no penalty. |
| Board navigation | Arrow keys between slots and columns | — | `board-dom.js` grid navigation; every card and slot is a focusable button. |
| Undo / Hint / Collect / Pause / Restart | `Z` / `H` / `A` / `Esc` or `P` / `R` | Bottom tray mirrors the rail buttons | Rebindable via `settings.keybindings` (stored as `KeyboardEvent.code`). |
| Camera reset | `0` | — | 3D only. |
| Gamepad | A confirm, B cancel, Start pause, D-pad navigation (180 ms repeat) | — | Polled at 60 ms; D-pad synthesises arrow keydowns on the focused element. |

**Input locking.** Every action handler returns early unless `phase === 'active' && !paused &&
status === 'active'`, and while any overlay is open the global key handler yields to the dialog.
Keys are ignored inside `INPUT/SELECT/TEXTAREA`. Cosmetic tweens keep running after the logical
state has settled; **Settle** (`btn-skip-anim`) snaps every object to the exact end state.

**Feedback for every input.** Selection outline + legal-target highlights, a sound, a haptic pulse
on move, a toast carrying the engine's own rejection sentence, and a live-region announcement for
hints, terminal states and recovery messages.

---

## 7. Screens and UI flow

```
boot → title ⇄ {modes, journey, learn, boards, settings, help}
title → (stage-setup | practice-setup | challenge-setup | daily-setup | chase-setup) → active
active ⇄ paused (pause overlay: resume, settings, help, restart, leave)
active → results → title | next stage | retry
```

`app.phase` is one of `boot | title | setup | active | paused | results` and is owned by
`src/main.js`. Overlays live in `#screens`; `openScreen` pushes onto a stack, moves focus to the
dialog heading, traps Tab inside it, and restores the previous focus on close. Backgrounding
(`visibilitychange`) pauses the deal, saves a snapshot and opens the pause screen; the player
resumes deliberately.

**Layout.**

- **≥1024 px:** three columns — left objective/progress rail, centre playfield, right action rail —
  with the bottom tray hidden.
- **<1024 px landscape:** narrow static rails are kept; the tray appears.
- **<1024 px portrait:** `#rail-left` becomes a static wrapping strip *above* the playfield (never an
  overlay on the cards), and the tray holds Undo / Hint / Collect / Pause in the thumb zone.
- Safe areas: `env(safe-area-inset-*)` is applied to `#app`, the topbar, the tray and every overlay.

**Never cut off:** the four cells and four foundations of the top row (they share the row width
`flex: 1 1 0; min-width: 0`, foundations in `row-reverse` so their left-to-right order matches the
3D scene ♣ ♦ ♥ ♠), the current lesson banner, the tray, and the primary button of any overlay.

---

## 8. Art direction

**Palette** (CSS custom properties, `brass-slate` default): desk `#2b3138`, brass trim `#b08d3e`,
accent `#d8b04c`, panels `#22282e` / `#1b2025`, ink `#e8e2d2` / dim `#b9b2a0`, card face `#f4efe4`,
suit red `#a63a3a`, suit black `#26282e`, danger `#c05a4a`. Four alternates ship as full theme
objects used by both CSS and the WebGL materials: **Verdigris** (`#25332f`/`#7ba88f`), **Night Ink**
(`#1c2030`/`#6d7bb0`), **Parchment** (`#6b5b41`/`#f0d493`) and **High Contrast** (`#000`/`#fff`,
accent `#ffdd00`). Colour-blind palettes recolour the suits only: deuteranopia `#b0660a`/`#2050a0`,
tritanopia `#c03040`/`#2060b0` — shape and rank text always carry the same information.

**Shape language.** Rounded-rectangle cards (10 px radius) with a squared-off brass lip on every
slot; nothing is circular. Cards are drawn to canvas textures at runtime (rank + suit glyph in the
corners, mirrored), so a theme change re-textures rather than swapping art.

**Typography.** Headings and card faces in a serif stack ("Iowan Old Style", Palatino, Georgia);
HUD, buttons and body in `system-ui`. Larger-text mode scales the root to 120 %.

**Hero of the screen.** The tableau. The rails are flat panels with no imagery; the only photographic
imagery on screen is behind full-screen overlays, where no card is visible.

**Motion.** One eased tween class (`easeInOut`) for card travel, a bounded particle pool for the win
burst, a small camera nudge on emphasis, and (Ambient motion on) dust motes drifting through the
lamp light with a barely perceptible breathing of the key light. Reduced motion makes every
`syncState` instant, disables particles and motes and cancels the nudge. Nothing that motion
communicates is *only* communicated by motion.

**Graphics.** The desk is lit by one warm key light (the desk lamp) with PCF soft shadows whose
frustum is fitted to the slate slab, a hemisphere fill and a cool rim, all through ACES filmic tone
mapping to sRGB. With Reflections on, a PMREM-filtered `RoomEnvironment` is the scene environment, so
the brass trim and slot frames read as polished metal and the card faces (a lightly clearcoated
physical material) carry a soft sheen that never lowers glyph contrast. The slate slab sits on a dark
walnut desktop lit by a baked lamp pool (vertex colours) that fades into a fogged, theme-tinted room,
so no framing shows empty background. Surface detail Detailed adds tileable procedural slate, felt
and wood-grain textures (colour + fine bump) and draws card faces at 2× with a linen weave and a gilt
inner rule — same layout, sizes and colours as Plain. Optional post-processing (EffectComposer on a
half-float target): bloom limited to the untone-mapped accents (selection/target rings, particle
sparks), a colour grade (gentle S-curve, slight saturation, warm highlights / cool shadows, lifted
blacks) with vignette, and FXAA, SMAA or MSAA. The Settings panel's **Graphics** section (after
Theme and Reduced motion) offers a quality preset — Auto (chosen from the unmasked GPU name:
software renderers get Low, discrete GPUs and Apple M-series get High, others Balanced; touch devices
are capped at Balanced), Low, Balanced, High, Ultra — a render scale (50–200 % on top of the preset's
scale; the device pixel ratio is capped at 1 / 1.5 / 2 / 2 per preset), one override per category
(Shadows off/low/medium/high = 0/1024/2048/4096 px maps, Reflections, Surface detail, Bloom, Colour
grade, Anti-aliasing, Particles off/low/high, Ambient motion), each defaulting to "From preset (…)",
adaptive resolution (averages 90 frames; above 26 ms steps down 0.1 to 60 %, under 14 ms steps back
up) and a frame-rate readout (bottom-left of the table, never over controls), plus a summary line
"GPU · cost summary · W×H px". Choosing a preset clears overrides; changes apply live and persist in
the settings key as `graphics`. Low renders directly with no composer, shadows or anti-aliasing (as
cheap as the former low tier); the composer runs only when an effect needs it. If the addons or the
chain fail, the table renders without post-processing and the panel says so. The panel's strings
follow `navigator.language` in the nine supported locales. `data-gfx-preset` on `<body>` and the
canvas reports the resolved preset.

**Visual assets the design calls for** (all under `assets/`, all wired through CSS so a missing file
degrades to the flat colour): a desk key-art backdrop for the title overlay; a felt texture under
the HTML board; a results backdrop of finished piles. Card faces, the desk, and every icon stay
procedural by design.

---

## 9. Audio direction

**Mix philosophy.** The desk is quiet. Effects are the loudest bus because they are the acknowledgment
of an input; music is a bed that never plays a melody. Nothing is audio-only: every cue has a visible
or announced equivalent.

**Buses** (independent gains, `src/audio.js`): `effects` 0.8, `music` 0.5, `ambience` 0.4, `voice` 0.7,
into a master gain. `unlock()` runs from the first gesture; backgrounding suspends the context.

**Music and ambience.** A two-chord sine pad (A-ish / E-ish, 4 s per change) behind a low-passed
brown-noise room tone. `setMusicIntensity(cardsHome / 52)` opens the filter from 500 Hz to 2.3 kHz
and fades in a fourth voice, so the desk quietly tightens as the foundations fill.

**Sample policy.** Each event first tries its authored Opus one-shot (fetched and decoded lazily on
first use, then cached); while it decodes, or if the fetch fails, the event falls back to its
procedural synth. Pitch variants are derived from the session seed, so a replay sounds identical.

### SFX event table — source of truth for `sfx/manifest.txt`

| event id | file | description | usage context |
|---|---|---|---|
| `select` | `card-select.opus` | Card lifted and tapped on felt, crisp paper snap | A card or run becomes the selection |
| `deselect` | `card-deselect.opus` | Card laid back on a stack, muted thud | Selection cleared (tap-again, Esc, gamepad B, cancelled drag) |
| `pickup` | `card-pickup.opus` | Card sliding off a deck, paper flick | Canvas drag begins |
| `drop` | `card-drop.opus` | Small stack landing flat on wood | Legal move onto a tableau column |
| `cell` | `cell-store.opus` | Card into a wooden slot, edge click | Legal move into a temporary cell |
| `foundation` | `foundation-build.opus` | Card snapped onto a squared pile | Legal move onto a foundation, incl. each Collect step |
| `invalid` | `move-invalid.opus` | Dull wooden knock | Engine rejects an attempt (toast carries the reason) |
| `undo` | `move-undo.opus` | Card sliding backwards across felt | Undo pops a snapshot |
| `hint` | `hint-chime.opus` | Brass desk bell, single soft ting | Hint highlights a ranked legal action |
| `lesson-step` | `lesson-step.opus` | Two wooden beads clicked | A Learn step is satisfied |
| `deal` | `deal-start.opus` | A deck laid out in quick succession, settling | A new deal starts (`startSession`) |
| `win` | `deal-win.opus` | Riffle and fan, celebratory flourish | `status: won` |
| `lose` | `deal-lose.opus` | Deck gathered and squared up | `status: lost` (conceded, move limit, time limit) |
| `star` | `star-award.opus` | Three rising brass pings | Results screen awards 1–3 Journey stars |
| `achievement` | `achievement-unlock.opus` | Brass trophy bell, sustained ring | First grant of an achievement key |

---

## 10. Localization

The required set is en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.

**Today:** the game ships **en-US only**, except the Settings panel's Graphics controls, whose
strings live in `src/gfx.js` for all nine locales (chosen from `navigator.language`, regional
variants falling back to their base table, then en-US). Player-visible strings live inline in `index.html`,
`src/ui.js`, `src/board-dom.js`, `src/main.js` (toasts, announcements) and `src/rules.js` (the
message half of every `fail(reason, message)`), and `<html lang="en">` is static. Everything that is
language-independent is already separated: rejection *reasons* are stable machine ids next to their
English sentences, card identity is a card id (labels are generated from `RANK_LABELS` /
`SUIT_SYMBOLS`), numbers and durations are formatted only at presentation (`fmtTime`,
`fmtDuration`), and content ids never appear in prose. Layout is written for expansion: no fixed-width
buttons, wrapping rails, and a 70-character maximum line length.

The remaining work — extraction into a string table keyed by the ids above, a locale chooser
defaulting to `navigator.languages` with a settings override, and the nine catalogues — is listed in
§17.

---

## 11. Accessibility

- **Keyboard-only path is complete:** skip link → title overlay (focus lands on the dialog heading,
  Tab is trapped) → Play → arrow keys around `#dom-board` → Enter to select and to commit → `Z`/`H`/`A`
  → `Esc` to pause → results. The e2e exercises exactly this path when pointer clicks are unavailable.
- **Focus:** 3 px accent outline via `:focus-visible`, restored to the invoking control when an
  overlay closes.
- **Screen readers:** every card and slot is a `<button>` whose `aria-label` spells the card
  ("nine of diamonds") and marks legal targets; empty slots carry short visible labels ("Cell 1", a
  suit glyph) with the long form in `aria-label`. Two live regions: polite for objectives, hints and
  progress, assertive for terminal states and save-recovery messages.
- **Contrast:** the High Contrast theme (and the `high-contrast` setting) forces `#000`/`#fff` with a
  `#ffdd00` accent; suit palettes cover deuteranopia and tritanopia without relying on hue alone.
- **Reduced motion:** a setting, honoured by both renderer (instant sync, no particles, no nudge) and
  CSS (`html.reduced-motion` removes card transforms).
- **Text size:** the Larger text setting scales the root to 120 % without breaking any layout.
- **Targets:** ≥44 × 44 CSS px with ≥8 px separation on touch layouts; the left-handed setting mirrors
  the tray.
- **No audio-only or hover-only information**, and no timing-critical input outside the optional
  timed challenge stages.

---

## 12. StarHermit integration

`starhermit.txt` declares `name`, `launch=index.html`, `owner`, `server=server.js`, `version` and
`cover=coverart.png`, per https://wiki.starhermit.com/ conventions.

**Used** (same-origin `/api/v1/*`; hosted mode activates iff a launch token was
read — `#game_token=<jwt>` in the URL fragment, stripped after reading; the JWT
payload supplies `sub` and `game_scope`. Query-param token fallbacks work only on
the local dev server. `localStorage` stays the offline cache):

| Feature | Endpoint | Behaviour |
|---|---|---|
| Token refresh | `POST /api/v1/games/{slug}/launch-token` | Re-mints the scoped token every 45 min (tokens live 60 min); failures retry after ~60 s. Every REST call carries `Authorization: Bearer`. |
| Identity | `GET /api/v1/users/{sub}/profile` | Nickname shown in the topbar player slot; `"Player " + id.slice(0,8)` fallback. Never `/api/v1/me`, never usernames. |
| Cloud save | `GET`/`PUT /api/v1/me/cloud-saves/{slug}` | Save doc + local boards as one stored zip (base64), ≤10 MB slot. Saves debounce 2 s and flush on pagehide; loads prefer the remote copy when newer; topbar shows sync state. |
| Leaderboard (read) | `GET /api/v1/games/{slug}`, `GET /api/v1/leaderboards/{id}/entries` | Read-only; entries resolve user ids to nicknames via the profile route. Personal bests stay local + cloud-mirrored. Clients never submit scores. |
| Daily clock | — | No client-reachable host time endpoint: the daily boundary uses the device clock when hosted; the local dev server still offers `GET /api/v1/time` sync. |

**Local dev server only** (`server.js` on localhost; never called on the StarHermit
host): `GET /api/v1/time`, `POST /api/v1/scores` (replay-validated), `GET
/api/v1/boards`, `POST /api/v1/presence`, `POST /api/v1/activity`, `POST
/api/v1/telemetry` (consent-gated). `server.js` keeps its hardening: per-identity
rate limiting with bucket pruning, strict type validation on
`seed`/`moves`/`durationMs`/`contentVersion`/`invalid` (422 with a stable error
id), `400` on a malformed percent-escape, a `__dirname + path.sep` static
boundary, and a body-size cap. Data lives in `.server-data/` (gitignored) or
`OPEN_CELLS_DATA`.

**Not used:** matchmaking, realtime sockets, chat, parties, purchases. Open Cells
is single-player; the only shared state is the seeded daily deal and the
leaderboard. Achievements stay local (part of the cloud-saved doc); `server.js`
is a Node static/API server, not a Jint game script, so there is no
server-authoritative unlock path.

---

## 13. Technical architecture

**Layering.** `rules` (pure) ← `session` (commands, undo, replay) ← `main` (phases, input, results)
→ `render` / `board-dom` / `ui` / `audio` / `platform`. Rendering never writes state; the two boards
are pure functions of `session.state` plus the current selection.

**Determinism and replay.** Only `tick` carries wall-clock, and it is stripped from replay logs; all
scoring inputs are integers. A replay is `initialHash + ordered commands + finalHash` and is
re-executable in Node, which is how `tools/validate.js` and the server both verify claims.

**Persistence.** `open-cells/save/v1` is a `{version, payload, checksum}` document (FNV-1a). A
structurally wrong or corrupt value is copied to a `*.corrupt.<timestamp>` key and the game starts
clean with an assertive announcement — it never bricks the boot. Settings and local boards are
separate keys with the same defensive reads. A resumable snapshot is written at most every 2 s and
on `beforeunload`.

**Rendering budget.** Graphics presets `auto|low|balanced|high|ultra` plus per-category overrides
(§8, `src/gfx.js`); a saved legacy `quality` tier maps to the matching preset. Low drops
anti-aliasing, shadows, reflections, post-processing and particles, and caps the pixel ratio at 1. Textures are cached per card+theme and disposed on theme change;
the particle pool is fixed-size and never a raycast target; WebGL context loss is caught and the
scene rebuilt. Devices without WebGL (or with the HTML-board setting on) get the DOM board with an
explanatory note — no error path.

**How the e2e drives the real UI.** `tests/e2e.mjs` serves the folder from an ephemeral port with a
stubbed `/api/v1/*`, launches Chrome through `playwright-core`, and at 1280×800 and 390×844 clicks
the visible buttons: title → Settings → Graphics (Low, High, a bloom override, frame-rate readout,
preset-clears-overrides, reload persistence, back to Auto) → HTML board → Play → two legal moves found by asking the live
engine for a legal action and then *clicking the corresponding DOM buttons* (falling back to focus +
Enter) → Hint → Collect → Undo → Pause/Resume → Settings persistence → Concede → results → a full
Learn lesson. It fails on any non-allow-listed console error or warning and screenshots each step.

---

## 14. Testing and acceptance criteria

`npm test` → `node --test tests/rules.test.js tests/session.test.js tests/gfx.test.js`, **37 cases**: card identity and
colour, deal shape and seed stability, ordered runs and capacity maths, every rejection reason,
safe-autoplay cascades, scoring components and tie-breaks, terminal reasons, serialization round-trip
and shape validation, hint ranking, undo/replay determinism, replay tamper detection, lesson stepping,
integer tick accounting, a fuzz pass of random commands that must never corrupt the deck, and the
graphics model (GPU detection, preset/override resolution, render-scale clamp, preset clears
overrides, legacy migration, cost summary, locale coverage).

`npm run test:e2e` → the flow in §13, both viewports, zero page errors.
`npm run validate` → the offline solver over lessons, journey, challenges and dailies.

**Acceptance bar (checkable):**

1. Every implemented feature is reachable by clicking visible UI at 1280×800 and 390×844.
2. No console errors or warnings during a full playthrough (GPU/SwiftShader noise excluded).
3. No text or control is clipped at either viewport; the top row's eight slots and the tray are fully
   visible in portrait.
4. A new player is taught: the objective is on screen from the first frame, illegal moves explain
   themselves, and Learn requires the player to perform each rule.
5. Keyboard alone completes a deal; screen-reader labels name every card and slot.
6. A corrupted save never blocks boot.
7. Ranked results carry a replay envelope that `validateReplay` accepts.
8. `node --check` passes on every shipped module.

---

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/title-key-art.webp` | Title-overlay backdrop (1280×720, multiply-blended under the scrim) | FLUX.2 klein, seed 41207 | generated in this pass, wired in `css/style.css` |
| `assets/desk-felt.webp` | Repeating felt texture under the HTML board (512², darkened 55 %) | FLUX.2 klein, seed 88113 | generated in this pass, wired in `css/style.css` |
| `assets/results-flourish.webp` | Results-overlay backdrop (1024×576) | FLUX.2 klein, seed 60411 | generated in this pass, wired in `css/style.css` |
| `coverart.png` | StarHermit cover, 1200×675 | authored | shipped |
| `icon.png`, `favicon.svg` | Launcher icon and tab favicon | authored | shipped |
| Card faces, desk, slots, particles | Runtime canvas textures and procedural Three.js geometry | `src/render.js` | shipped (procedural by design — no card art files) |
| `sfx/*.opus` (15 clips, see §9) | Authored one-shots for every audio event | MOSS-SoundEffect v2.0, 100 steps | shipped; `deal-start.opus` and `star-award.opus` generated in this pass |
| `sfx/manifest.txt` | Canonical file → event → description → context map | authored | shipped |
| `sfx/manifest.json` | Generator input (name, seconds, prompt, event) | authored | shipped, in sync with the table above |
| Character animation | — | — | not applicable: no humanoid characters |
| 3D model files | — | — | not applicable: all geometry is procedural |

---

## 16. Known limitations

- **English only.** See §10; the string table does not exist yet.
- **No dead-end detection.** A board with no legal move stays `active`; the player must concede.
  There is no "no moves left" announcement.
- **`tools/validate.js` cannot prove every future daily.** Seeds are derived from the date, so a
  given day may exceed the solver's node budget (currently 54/55 items proven, the unproven item
  being a future daily). Journey and challenge seeds are all baked and proven.
- **`server.js` serves `tests/` and `tools/`.** The static handler only blocks `.server-data` and
  path escapes; the repository convention is that dev files are never served.
- **Audio cannot be verified headlessly.** Chrome blocks the AudioContext before a gesture, so the
  e2e proves the cues do not throw, not that they sound.
- **`validateReplay` does not re-apply the `noAuto` constraint to `auto` entries** (`src/session.js`);
  `applyCommand` refuses the move anyway, so the hash is unchanged and no divergent outcome exists.
- **The 3D scene is only smoke-tested.** SwiftShader runs prove absence of errors, not visual
  correctness.
- Turning the 3D board back on from HTML mode reloads the page (a deliberate clean rebuild, but it
  costs the unsaved part of the current move).

---

## 17. Design intent not yet implemented

1. **Localization for the nine required locales**: extract every player-visible string into a keyed
   table (rejection ids already exist), choose the locale from `navigator.languages` with a settings
   override, and set `<html lang>` at boot.
2. **"No moves left" detection** — announce it and offer Undo or Concede rather than leaving the
   player to notice.
3. **Static-server hardening**: refuse `tests/`, `tools/` and dotfiles in `server.js`, matching the
   repository convention.
4. **Voice bus content** — the bus exists and is mixed, but nothing is routed to it.
5. **A brass card-back texture** for the 3D scene's face-down states; the scene currently has no
   face-down card, so `backTexture` is drawn procedurally and no authored art is wired to it.
