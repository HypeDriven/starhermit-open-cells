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
| Platforms | The StarHermit engine 1.22.0 (script game, host API 1.21, `engine.minor=20`): natively in the StarHermit client and in browsers through the engine's web runtime; desktop and phones, portrait and landscape; keyboard, mouse, touch and gamepad |
| Rendering | `starhermit:scene` desk (the browser build's three.js r152 scene ported as written) under a `starhermit:ui` interface; every card and slot is also a named accessibility target |
| Persistence | The engine save (`starhermit:storage` `saves`): on the device and, signed in, in the player's cloud slot |
| Networking | The StarHermit platform through `starhermit:platform` when signed in; guests play fully offline |

### File map

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.22.0`, `engine.minor=20`, `engine.capabilities=platform,storage,clipboard`, `server=score-script.js`, `cover=cover.jpg`, a `control.*` line and an `engine.gamepad.*` line per action. |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (`starhermit package --web .`); never edited by hand. |
| `native/main.ts` | Entry module: the app state machine and screen stack, starting every mode, resuming the saved deal, session events (sounds, sparks, nudges, announcements, lessons), selection and moves from taps, drags, double taps, keys and pads (the board cursor), hints, Collect, undo, restart / concede confirmations, the deal clock on fixed steps, results and progression bookkeeping, lifecycle. |
| `native/screens.ts` | Every screen on `starhermit:ui`: top bar, rails, tray, toasts, the board's named targets and cursor, and the overlay screens (§7). |
| `native/render.ts` | The desk on `starhermit:scene`: camera framing in the playfield rectangle, desk geometry and materials, cards with atlas faces, selection / target rings, tweens, sparks, motes, nudge, picking and dragging, the look per quality tier. |
| `native/quality.ts` | The browser build's presets and budgets (`src/gfx.js`) keyed by the runtime's quality tier and level. |
| `native/audio.ts` | One-shots from `sfx/`, the ambience and music pad rendered to looped clips. |
| `native/platform.ts` | The save `{ save, boards }` with conflict merge and old cloud-slot migration, the game's options as engine settings (legacy KV adoption and removal), player, invite link, platform clock, score posting, leaderboard reads. |
| `native/i18n.ts`, `native/style.ts`, `native/classic.ts` | Interface language → string tables; the converted style sheet with theme / contrast / palette tokens; loading the classic scripts below with their types. |
| `src/rules.js` | Pure engine: deal, legality, supermove capacity, safe autoplay, scoring, terminal reasons, hashing, seeded RNG. |
| `src/session.js` | Validated commands, undo snapshots, replay envelope + `validateReplay`, hints, lesson tracking, event emission. |
| `src/content.js` | 6 lessons, 40 journey stages, 6 challenges, 3 practice difficulties, daily derivation, 5 themes, 5 achievements. |
| `src/store.js` | The save document (empty / migrate / merge), local boards (add / merge), the old cloud slot reader, option validation. |
| `src/i18n.js`, `src/locales/*.js`, `src/sh-strings.js` | Localization core (`T()`), the nine locales' tables, the account controls' strings. |
| `score-script.js` | StarHermit platform script (`server=score-script.js`): range-checks a finished ranked deal's total and posts it to the `high-score` leaderboard. |
| `tools/ui-style.css` → `assets/ui-style.json` | The class-based style sheet and its `starhermit css` conversion (`npm run css`). |
| `tools/bake-textures.mjs` → `assets/textures/` | The old canvas painters run in Chrome: card-face atlases per theme, palette and surface detail; slate, felt and wood textures. |
| `tools/gen-plays.mjs` | Generates `tests/native/journey-1.play` (solver path) and `lessons-phone.play`. |
| `tools/browser-play.mjs` | Plays the web package in GPU Chrome at desktop, phone and phone landscape. |
| `tools/validate.js` | Offline solver proving lessons and every shipped deal seed. |
| `tests/` | `rules.test.js`, `session.test.js`, `store.test.js`, `i18n.test.js` (`node --test`), `native.mjs` and `native/*.play` (engine checks). |
| `sfx/` | 15 Opus clips + `manifest.txt` (canonical), `manifest.json` (generator), `manifest.md`. |
| `assets/` | Key art, baked textures, the converted styles (§8, §15). |

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
moves, and any effect whose removal (reduced motion, low quality) would hide state.

**4. One board, every input.**
Rules in: taps, clicks, drags, the keyboard / pad board cursor and screen readers all reach the same
press handler (`handleCardPress`) over the same `state`; every card and slot is a named accessibility
target, so any input can complete any deal. Rules out: hover-only previews or drag-only moves.

**5. A result you can prove.**
Rules in: integer scores, a component breakdown on the results screen, a replay envelope attached
to every ranked submission, and a server that ranks validated claims above unvalidated ones.
Rules out: wall-clock scoring the client can fudge, and secret tie-breaks.

---

## 3. Player experience

**Target player.** Someone who already knows a free-cell-style patience game and wants a tidy,
quiet, unrandomised version of it — plus a curious newcomer the Learn track can carry.

**First 60 seconds.** Boot lands on the title overlay over the desk key art, with Play the dominant
button and `Learn` one row below.

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

| Input | Keyboard / mouse | Touch | Gamepad | Result |
|---|---|---|---|---|
| Select | Click a card; or move the board cursor and press Enter / Space | Tap | South on the cursor | Selection set; the cards lift with an accent glow, a ring marks the pile and every legal destination; `select` cue; announced with the target count. Pressing a card inside an ordered run selects the run from there down; a buried card selects its column's movable top. |
| Cancel | Click the selection again, Escape | Tap the selection | East | Deselect + `deselect` cue. |
| Move | Click a ringed target, or drag the card / run onto it | Tap the target, or drag with a finger | South on the target | `attemptMove`; on success `drop` / `cell` / `foundation` cue and a 15 ms haptic pulse. |
| Smart move | Double-click (< 0.4 s, same card) | Double-tap | — | Foundation if legal, else the first free cell. |
| Return to origin | Drop on the source pile | same | — | A cancel: no turn, no invalid attempt, no penalty. |
| Board cursor | Arrow keys (`nav_*`) | — | D-pad / left stick | Moves between cells, foundations (right to left, as on the desk) and the columns' cards (board-dom.js's grid navigation); drawn as an accent frame and announced ("nine of diamonds, column 3, card 5 of 7"). |
| Undo / Hint / Collect | Z / H / A, or the Actions rail / tray | the tray | West / North / right shoulder | Undo pops a snapshot; Hint rings the best ranked legal move and announces it; Collect sweeps every safe card home (not in no-auto deals). |
| Pause | P, Escape (no selection), Pause in the top bar or tray | the tray | Start | Pause screen; the clock stops. |
| Restart / Concede | R, the rail's Restart / Concede | pause → Restart deal | Select (restart) | An inline Yes / Cancel confirmation (replaces `window.confirm`). |
| Camera reset | 0 / Numpad 0 | — | right stick press | Re-frames the desk. |

Every key and pad button is an engine action (`control.*` / `engine.gamepad.*` in `starhermit.txt`);
players rebind them in the runtime's Options (Settings → Key bindings opens it). Help and Settings show
the effective keys.

**Taps and drags.** A press on the desk is decided after the frame's UI is built (presses on the bars,
rails and tray are theirs). A press that moves more than 8 px is a drag: the card or run follows the
pointer over the desk and drops on the slot or card under the release; with **Hold to drag** on, a drag
starts only after a 0.3 s hold (the old setting was stored but unused; it works now). Any press on the
desk first settles running animations (Settle in the rail does the same).

**Input locking.** Moves, undo, hint and Collect act only while a deal is active, not paused and no
screen is open; while a screen is open its own widgets take the keys and Escape closes it (never on
the frame it opened). Text fields (the Score Chase seed) hold the keyboard while focused.

**Feedback for every input.** Selection lift, rings and glow, a sound, a haptic pulse on move, a toast
carrying the engine's own rejection sentence, the camera nudge on a refusal, and screen-reader
announcements for selections, the cursor, hints, terminal states and recovery messages.

---

## 7. Screens and UI flow

```
start → title ⇄ {modes, journey, learn, scores, settings, help}
title / modes → (stage-setup | practice-setup | challenge-setup | daily-setup | chase-setup) → active
active ⇄ paused (pause screen: resume, restart deal, settings, help, leave deal)
active → results → title | next stage / lesson | retry
```

`app.phase` is `title | active | paused | results` (`native/main.ts`). Screens are a stack
(`ui.js openScreen`): the top one is a modal `ui.dialog` with its title, a persistent ✕ close control
and the screen's body (scrolling inside when taller than the window); Escape / Back closes it; closing
the pause screen resumes. The title shows **Play** (or **Continue** with a saved deal), Daily Deal,
Journey, Modes, Learn, Scores, Settings, Help, Sign in / Invite when the platform offers them, the
journey and streak line and the next daily's countdown. A hidden window (`onSuspend`) pauses the deal
and saves it; the player resumes deliberately.

**Layout** (the old media queries, picked by the window's logical size):

- **≥ 1024 px wide:** the top bar; the Objective / Progress rail (240 px) left, the Actions rail
  (220 px) right, the desk between them.
- **< 1024 px landscape:** a 150 px Objective / Progress rail beside the desk; the tray (Undo, Hint,
  Collect, Pause) along the bottom.
- **< 1024 px portrait:** the rail becomes a wrapping strip above the desk (never over the cards); the
  tray holds Undo / Hint / Collect / Pause in the thumb zone. Left-handed mirrors the tray.
- Safe areas and the UI scale are the runtime's (Options › text size and large screens); the desk is
  framed in the playfield rectangle left between the bars and rails (`setViewOffset`), with the desk
  colour painted around it.
- Top-bar chips (player, sync, deal) give way on narrow windows so Menu / Pause stay clear.

**Never cut off:** the four cells and four foundations, the lesson banner, the tray and the primary
button of any screen (screens scroll inside).

---

## 8. Art direction

**Palette** (style tokens, `brass-slate` default): desk `#2b3138`, brass trim `#b08d3e`,
accent `#d8b04c`, panels `#22282e` / `#1b2025`, ink `#e8e2d2` / dim `#b9b2a0`, card face `#f4efe4`,
suit red `#a63a3a`, suit black `#26282e`, danger `#c05a4a`. Four alternates ship as full theme
objects used by both CSS and the WebGL materials: **Verdigris** (`#25332f`/`#7ba88f`), **Night Ink**
(`#1c2030`/`#6d7bb0`), **Parchment** (`#6b5b41`/`#f0d493`) and **High Contrast** (`#000`/`#fff`,
accent `#ffdd00`). Colour-blind palettes recolour the suits only: deuteranopia `#b0660a`/`#2050a0`,
tritanopia `#c03040`/`#2060b0` — shape and rank text always carry the same information.

**Shape language.** Rounded-rectangle cards (10 px radius) with a squared-off brass lip on every
slot; nothing is circular. Card faces are the old canvas painters' output, baked per theme, suit
palette and surface detail (rank + suit glyph in the corners, mirrored), so a theme change re-textures
rather than swapping art.

**Typography.** Headings and card faces in a serif stack ("Iowan Old Style", Palatino, Georgia);
HUD, buttons and body in the runtime's sans-serif. Larger text is the runtime's text size.

**Hero of the screen.** The tableau. The rails are flat panels with no imagery; the only photographic
imagery on screen is behind full-screen overlays, where no card is visible.

**Motion.** One eased tween class (`easeInOut`) for card travel, a bounded particle pool for the win
burst, a small camera nudge on emphasis, and (Ambient motion on) dust motes drifting through the
lamp light with a barely perceptible breathing of the key light. Reduced motion makes every
`syncState` instant, disables particles and motes and cancels the nudge. Nothing that motion
communicates is *only* communicated by motion.

**Graphics.** The desk is lit by one warm key light (the desk lamp) with soft shadows, a
hemisphere fill and a cool fill, through ACES filmic tone mapping (exposure 1.05) — the browser build's
three.js r152 scene with its intensities and colours as written. With Reflections, a
`RoomEnvironment` filtered through `PMREMGenerator` is every standard material's environment (the
per-material intensities of r152: brass 1.1, slot frames 1.0, slate 0.35 …), so the brass reads as
polished metal and the card faces (a lightly clear-coated physical material on High and Ultra) carry
a soft sheen. The slate slab sits on a dark walnut desktop lit by a lamp pool baked into vertex
colours, fading into a fogged, theme-tinted room. Surface detail Detailed adds the slate, felt and
wood-grain textures (with the fine bump on High and Ultra) and draws the faces at 2× with a linen weave
and a gilt inner rule. Bloom (High, Ultra) reaches only the untone-mapped accents (selection / target
rings, sparks): the runtime blooms before tone mapping, so the old 0.9 threshold is taken back through
the curve (1.8). The colour grade (0.18 S-curve, +7 % saturation, cool shadows / warm highlights,
vignette 0.24) is `renderer.grade`; anti-aliasing is FXAA / SMAA / MSAA per tier.

**The look per graphics level** (`native/quality.ts`): the runtime's Options choose the graphics level
(Auto by the device, or the player's), its tier picks the browser build's preset and budget, and the
level within the tier scales the spark pool and the dust motes (≤ 2×). Render scale, the pixel-ratio
cap, adaptive resolution, the frame-rate limit and readout are the runtime's; the old Graphics panel's
per-category overrides are not offered.

| Tier | Shadows | Reflections | Surface detail | Bloom | Grade | AA | Particles | Ambient motion |
|---|---|---|---|---|---|---|---|---|
| Low | off | off | Plain | off | off | off | off | off |
| Balanced | 1024 | on | Detailed | off | on | FXAA | low | off |
| High | 2048 | on | Detailed | on | on | SMAA | high | on |
| Ultra | 4096 | on | Detailed | on | on | MSAA | high | on |

| Budget | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Desk and card shading | Lambert | Standard | Standard desk, clear-coated Physical faces | as High |
| Card faces | 128×184 | 256×368 | 256×368 | 256×368 |
| Wood texture (slate and felt ½) | — | 256 px | 512 px | 1024 px |
| Slate / felt fine bump | no | no | yes | yes |
| Card corner segments | 3 | 4 | 8 | 12 |
| Lamp-pool grid of the surround | 24×20 | 36×30 | 60×50 | 60×50 |
| Spark pool at Particles High (Low: ½) | 120 | 200 | 400 | 600 |
| Dust motes | 30 | 40 | 70 | 120 |
| Bloom resolution | — | — | ½ | full |

**Visual assets:** the desk key art behind the title, the results flourish behind the results (both
under a dark scrim, left out in high contrast), and the baked textures (§15). Card faces, the desk and
every icon stay procedural in origin.

---

## 9. Audio direction

**Mix philosophy.** The desk is quiet. Effects are the loudest bus because they are the acknowledgment
of an input; music is a bed that never plays a melody. Nothing is audio-only: every cue has a visible
or announced equivalent.

**Buses** are the runtime's (Options › Audio: master, music, effects, interface, the mute and the
voice limit). Effects play on `effects`; the ambience and music play on `music` (the runtime has no
ambience bus; the ambience's gain folds in the old ambience default of 40 % against music's 50 %).
Clips load once the mixer runs (natively at once, in a browser after the first press), one at a time.
The pause screen and a hidden window fade the bed out.

**Music and ambience.** A two-chord sine pad (A-ish / E-ish, a 1.6 s glide every 4 s) behind a
low-passed brown-noise room tone, rendered once into looped clips. As cards go home
(`setMusicIntensity(home / 52)`) the pad grows a little louder and a fourth voice fades in (440 Hz,
pitched a third and then a fifth up past half and four fifths), so the desk quietly tightens as the
foundations fill.

**Sample policy.** Each event plays its authored Opus one-shot; a clip still loading is silent (the
old procedural fallbacks were live synthesis, which the web runtime cannot mix with clip loads).

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

The required set is en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT. The language is
the runtime's interface language (`preferences().language`: Options › Language, else the account's
preferred language, else the device's), mapped to the nearest shipped locale (`es-MX → es-419`,
`en-AU → en-GB`, `fr → fr-FR`); a change shows on the next frame (every string is drawn through `T()`
each frame), the deal untouched. The old in-game Language setting and its `ui.language` KV key are gone.

Every player-facing string ships in all nine locales: every screen, the bars, rails and tray, the
board targets' names (card names such as "six of spades" composed per locale), toasts and
announcements, confirmations, the rules and session refusal sentences (`src/rules.js` /
`src/session.js` keep English sentences; `native/main.ts` translates them, including the two with
numbers), and the content tables. Strings are keyed by their US-English text in `src/locales/*.js`
(es-ES and fr-CA list only their differences, en-GB only its spelling changes); the account strings
live in `src/sh-strings.js`. The game name, seeds, deal ids and card faces stay as they are.
`tests/i18n.test.js` checks that every key used in `native/*.ts` and the content (extracted by
`tests/i18n-keys.js`) exists in all nine locales with the same placeholders and that no table carries
stale keys.

---

## 11. Accessibility

- **Keyboard and pad complete a deal:** Tab / arrows through every screen's widgets; on the desk the
  board cursor (arrows / D-pad) with Enter / South to select and to place, Z / H / A, P / Escape to pause.
- **Screen readers:** every widget has its role and name; every card and slot on the desk is a named
  target ("nine of diamonds, column 3, card 5 of 7", "Empty cell 2", "hearts foundation, empty");
  selections, the cursor, hints, refusals, results and recovery messages are announced (assertive for
  refusals and terminal states).
- **Contrast:** the runtime's high contrast swaps in the High Contrast palette (`#000` / `#fff`, accent
  `#ffdd00`) for the interface and drops the key art; the High Contrast table theme does the same for
  the desk. Suit palettes (deuteranopia, tritanopia) recolour the card faces and never rely on hue alone.
- **Reduced motion** (the runtime's): instant moves, no particles, motes or camera nudge.
- **Text size and UI scale** are the runtime's; layouts wrap rather than clip.
- **Targets:** ≥ 44 × 44 logical px; the left-handed option mirrors the tray.
- **No audio-only or hover-only information**, and no timing-critical input outside the optional timed
  stages.

---

## 12. StarHermit integration

On the engine through `starhermit:platform` and `starhermit:storage`:

| Feature | Behaviour |
|---|---|
| Save | `saves` holds `{ save, boards }` (src/store.js): on the device, and signed in in the player's cloud slot. A write that lost to another device's merges through `mergeData` (per journey stage the most stars, best score and fewest moves; lessons, dailies — higher score per day — and achievements unioned with the earliest unlock; the daily streak with the later date; the larger of each total; this device's in-progress deal; boards unioned by session id). A save from elsewhere that replaced the device's is merged in the same way. |
| Old cloud slot | The browser build's `game:<slug>` slot (`{ kind: 'open-cells/cloud/v1', savedAt, save, boards }`, written by the JS SDK) shows as foreign: it is merged with the device's save and replaced once (`replaceForeign`). Guests' old browser `localStorage` progress does not migrate. |
| Options | The game's own options — table theme, left-handed layout, hold to drag, haptics, suit colour palette, tutorial complete — are engine `settings` (synced with the account). The browser build's values in the account's settings KV are adopted unless set here since; all its KV keys (theme, graphics, reduced motion, contrast, text size, handedness, hold-to-drag, haptics, palette, volumes, mute, `ui.language`) are then removed. Volumes, mute, graphics, reduced motion, contrast, text size, language and bindings are the runtime's Options (Settings → Open Options / Key bindings). |
| Sign-in / sign-out | Guests see **Sign in with StarHermit** on the title (`requestSignIn`); a session that ends shows "Signed out — playing locally" and play goes on. |
| Identity | The player's display name and the cloud-save state (saving… / cloud save ✓ / sync failed) in the top bar. |
| Invite | Signed in, **Invite a friend** copies the invite link (`clipboard` capability) and confirms with a toast. |
| High-score board | Every finished ranked deal (Journey, Daily, Challenge, Score Chase — not Learn or Practice) posts its total through `score-script.js` (a practice session whose socket carries `{ type: 'result', scores: { 'high-score': total } }`; the script range-checks it, 0–50,000, and posts it); the results then show "Leaderboard rank: #N" (or posted / not posted). Results and leaderboards are server-authoritative per platform policy: the client only offers the total, the script decides what is posted. |
| Leaderboard (read) | Scores shows the `high-score` board's top ten with names and the player's best; personal bests stay on the local boards in the save. |
| Daily clock | The platform's clock (`serverTime` / `serverNow`) decides the daily deal when it has answered; otherwise the device's UTC date (the daily setup says which). |

Not used: rooms, matchmaking, realtime, chat, purchases. Achievements stay in the save (no
server-authoritative unlock path; `score-script.js` posts only scores). Signed-in paths (cloud merge,
the foreign slot, KV adoption, score posting) are covered by unit tests of their logic
(`tests/store.test.js`) and were not live-tested here.

---

## 13. Technical architecture

**Layering.** `rules` (pure) ← `session` (commands, undo, replay) ← `native/main.ts` (phases, input,
results) → `render.ts` / `screens.ts` / `audio.ts` / `platform.ts`. Rendering never writes state; the
desk and the targets are pure functions of `session.state` plus the selection. The classic scripts
(`src/*.js`) load through `loadClassic` and run unchanged in the Node tests.

**Determinism and replay.** Only `tick` carries time: the deal clock adds 250 ms every 15 fixed steps
(1/60 s) while the deal is active and the window shown, so play scripts replay exactly. A replay is
`initialHash + ordered commands + finalHash`, re-executable in Node (`validateReplay`).

**Persistence.** The engine save (above). A resumable snapshot of the deal is written at most every 2 s
of play, on pause and when the window is hidden; Continue resumes it with the clock as it was.

**Rendering.** One scene; the look per tier (§8). Card geometry is one extruded rounded rectangle per
card with its faces' UVs in the atlas; faces share the atlas texture, every card one edge material.
Camera picking (cards first, topmost wins; then slots) uses the engine's raycaster through the
view-offset camera.

---

## 14. Testing and acceptance criteria

`npm test` runs:

- `npm run test:unit` → `node --test` over `tests/rules.test.js`, `session.test.js` (the engine and
  session suites: legality, every rejection reason, capacity maths, safe autoplay, scoring and
  tie-breaks, terminal reasons, serialization, hints, undo / replay determinism and tampering, lessons,
  tick accounting, a fuzz pass), `store.test.js` (save merge, foreign slot, boards, options) and
  `i18n.test.js` (locale coverage, placeholders, no stale keys, account strings).
- `npm run test:native` → `tests/native.mjs`: the web index is up to date, `tsc` (no `skipLibCheck`),
  `starhermit check .` with zero warnings, and every `tests/native/*.play` as a signed-out render check
  driving the real UI:
  - `journey-1.play` (generated): Journey stage 1 played to "Deal cleared." by clicks on the named card
    and slot targets (a 102-move solver path), three stars, Next stage;
  - `lessons-phone.play` (generated, 390 × 844 at DPR 3): all six lessons by finger touches, Collect
    from the tray, to the Desk Mechanic achievement;
  - `drag-lesson.play`: lesson 4's run dragged by the mouse onto the 9♠;
  - `menus.play`: Modes, How to play, Settings (a toggle), Scores, the Daily and Score Chase setups
    (typing a seed), the board cursor and Enter, Hint, pause / resume, Restart and Concede with their
    confirmations, the conceded results;
  - `landscape.play` (844 × 390 at DPR 3): a Practice deal from Play, Hint / Undo / Pause from the tray.
- `npm run test:browser` → `tools/browser-play.mjs`: the packaged loader in GPU Chrome at 1280 × 800,
  390 × 844 and 844 × 390 (DPR 3): lesson 4 dragged by mouse and by finger, lesson 1 by taps, a
  Practice deal by keys (cursor, Enter, Escape, H, P), the tray's Hint; fails on console errors or
  warnings or the runtime's error screen.
- `npm run validate` → the offline solver over lessons, journey, challenges and dailies.

**Acceptance bar:** every feature reachable by visible UI at desktop, phone and phone landscape; no
console errors; nothing clipped; keyboard alone completes a deal; every card and slot named; ranked
results carry a replay envelope that `validateReplay` accepts.

---

## 15. Asset inventory

| Path | Purpose | Source |
|---|---|---|
| `assets/title-key-art.webp` | Title backdrop under a dark scrim | FLUX.2 klein, seed 41207 |
| `assets/results-flourish.webp` | Results backdrop | FLUX.2 klein, seed 60411 |
| `assets/textures/faces-<theme>[-<palette>]-<plain\|detailed>.webp` | Card-face atlases (13 × 4) | baked from the old `cardTexture` (`npm run textures`) |
| `assets/textures/{wood,slate,felt}-<px>.png` | Grey surface textures tinted by the theme | baked from the old `surfaceTexture` |
| `assets/ui-style.json` | Converted interface styles | `npm run css` from `tools/ui-style.css` |
| `cover.jpg`, `coverart.png`, `icon.png` | StarHermit cover and icon | authored |
| `sfx/*.opus` (15 clips, §9) | One-shots for every audio event | MOSS-SoundEffect v2.0 |

---

## 16. Known limitations

- **No dead-end detection.** A board with no legal move stays active; the player must concede.
- **`tools/validate.js` cannot prove every future daily** (date-derived seeds may exceed the solver's
  node budget). Journey and challenge seeds are baked and proven.
- **`validateReplay` does not re-apply the `noAuto` constraint to `auto` entries**; `applyCommand`
  refuses the move anyway, so the hash is unchanged.
- **Port differences.** The old Graphics panel's per-effect overrides, render-scale slider and FPS
  readout are the runtime's level choice and Options; Ultra's 3× card faces use the 2× atlas; the HTML
  board (a fallback without WebGL) is replaced by the named board targets and the keyboard cursor; a tap
  on a card inside an ordered run selects the run from that card down (the old 3D tap took only the top
  card; the old HTML board did this); the procedural sound fallbacks while a clip loads are gone; guests'
  old browser progress does not migrate.
- **Practice seeds** come from the device clock hashed with a counter (no `Math.random` in the rules
  path), so two practice deals in one frame differ.

---

## 17. Design intent not yet implemented

1. **"No moves left" detection** — announce it and offer Undo or Concede.
2. **Voice bus content** — nothing is routed to the interface bus yet.
3. **A brass card back** for face-down states; the desk has no face-down card.
