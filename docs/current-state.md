# Current state

## Observation-v3 broadcast schema (uncommitted)

New `observation-v3` schema alongside v1/v2 on branch
`feature/commentary-refinements`, no legacy behavior change: HUD
readings plus visible cues with unknown-as-null semantics
(`docs/contracts/observation-v3.md`), v3 constants in `config.py`
(deliberately absent from the legacy version tuple), strict
`vision/observations_v3.py` validator reusing the shared JSON/fence
parsing, and an additive `broadcast_vision_prompt` pack field for all
three games (Free Fire layout per spec; CoD/BGMI best-effort marked
unverified). ADR 0017 records the broadcast pipeline shape and why
the keyword tagger is not used. No v3 caller exists yet; legacy
vision calls, worker, state/events/commentary/script untouched.

Verification: 44 new offline tests (`test_observation_v3`: valid
examples, one test per rejection rule, v1/v2 separation, pack field);
full Python suite 909 tests with only the 3 pre-existing clean-tree
failures (Windows `con` path, api_activity leak, opening
already-emitted).

## False-combat and scenery-spam fixes, recorded path (uncommitted)

Signal-layer fix on branch `feature/commentary-refinements`, no
pipeline or schema change. `state/gameplay.py`: all sixteen word
lists now match as whole terms on word boundaries under a negation
guard (clause splitting on `[.;,]`/`and`/`but`/`or`, cue-before-match
suppression, negated `not clearly visible` constructions, whole-list
inheritance after a leading negation, plus a description-opens-negated
strip of combat/zone/grenade/smoke/vehicle/knockdown/elim tags);
`finished`/`flush` removed from `ELIM_WORDS`; `occluded_entities`
excludes unlinked `unknown-` tracks (raw tracks unchanged).
`commentary/narrative.py` prints "Combat is active" only for a
current fact with a non-negated combat tag. `caster/producer.py`
skips `blue_wall_use` claims like scene claims (zone kept).
`events/detection.py` engagement sightings exclude negated
combat-category wording via a new `entry_wording_negated` helper
(unnegated category counting preserved). Docs: `gameplay-v1.md`
lexicon/`occluded_entities` wording, `events-v1.md` sighting
sentence, `script-v1.md` one-liner; no schema bump (shapes, enums,
consumers unchanged). Fixture effect (replay final window): events
31→15 (`combat_engagement` 4→1 — the survivor clusters 13
timestamps of unnegated combat-categorized cover plus the genuine
firing-glow frame; `blue_wall_use` 27→14 as plural `Walls` stops
matching); claims 32→15; beats 6→1 with zero `No…`-worded and zero
`blue_wall_use` beats; occluded 118→0; narrative now "No combat in
the latest observations."

Verification: 14 new offline tests (`test_false_combat`,
including fixture predicates for fewer-than-4 engagements and no
negation-worded beat); two existing fixtures reworded to singulars
(`tracers`→`tracer`, `Blue Walls`→`Blue Wall`) where they encoded
substring matching; full Python suite 865 tests with only the 3
pre-existing clean-tree failures (Windows `con` path, api_activity
leak, opening already-emitted).

## Golden fixture + offline replay/eval tools (uncommitted)

No pipeline behavior changes on branch `feature/commentary-refinements`:
`tests/fixtures/real_clash_squad_run1/` holds a real 63.27s Free Fire
Clash Squad run (30 `observation-v2` files + `adaptive_run.json`, 122
entries; environment 30 / other 16 / combat 43 / character 33) with a
README of known fixture defects (D1: 29 negation entries filed as
positive combat/other claims; D2: zero `subjects`/`action`/`spatial`
usage; D3: zero `hud` entries). New `python/tools/replay_legacy.py`
replays the run offline through the deterministic stages only
(validate → match state → events → gating → writer prioritization →
gameplay → narrative → script prompt, mirroring the streaming window
trigger), writing one `prompt_window_NN.txt` per window (13 on the
fixture). New `python/tools/eval_script.py` reports the automated
script metrics (lines, words/sec, lines/minute, forbidden-meta-word
hits, number tokens, overlap count with WAV or words/2.5 durations).
Nothing under `python/ai_commentator/`, `python/worker.py`, or
`electron/` touched. Gaps: `docs/eval/commentary-rubric.md` does not
exist, so the forbidden-phrase list and metric definitions are fixed
in the tool docstring/output instead; fixture defect IDs D1-D3 were
undefined in the brief and describe observed fixture properties.

Verification: 6 new offline tests (`test_replay_tools`, `python -I`
subprocesses with keys scrubbed); full Python suite 851 tests with
only the 3 pre-existing clean-tree failures (Windows `con` path,
api_activity leak, opening already-emitted). Replay prints
negation-entry count 29 as required.

## Caster-first intelligence architecture (uncommitted)

The recorded-gameplay pipeline now runs perception → temporal
reconstruction → gameplay analyst → caster producer → beat-driven
writer → editorial review → existing TTS/export, on branch
`feature/commentary-refinements` (prior overhaul work committed as
76c0bfe). `state/gameplay.py` gains weapon/equipment and
round-state/match-phase signals plus per-track engagement timelines
and tracking confidence (all additive; `gameplay-v1` compatible). New
`caster/` package: `beats.py` (strict beat schema wrapping gated
claims via `source_claim_ids`), `analyst.py`
(`observed_facts`/`interpretations`/`hypotheses`/`unknown` separation)
with modular `games/clash_squad.py`, and `producer.py` (chronological
beat sheet, priority/delivery, 5s pacing, silence, no-repeat,
`must_not_claim`). The sequential script path (`script/runner.py`)
scores beats via `build_beat_prompt`; `script-v1` segments shape
unchanged so TTS/export keep working. Uncertainty no longer leaks
into speech: qualifiers are internal-only, templates speak cautious
grounded lines, and `script_text_valid`/`writer_text_valid` reject
leaked validation language; new `script/review.py` adds the
caster-quality reviewer with one deterministic rewrite-or-drop (never
a second model call). Streaming windows keep the legacy claims path
(recorded MVP; non-goal).

Verification: 66 new targeted tests (`test_reconstruction` 24,
`test_producer` 20, `test_caster_writer` 22); full Python suite 845
tests with only the 3 pre-existing clean-tree failures (Windows `con`
path, api_activity leak, opening already-emitted). Existing suites
with intended-behavior fallout updated minimally (script,
commentary, writer, opening, streaming fakes); old leak-wording
expectations replaced with no-leak assertions. Real-footage
acceptance not run (no footage or key in this environment).

## Gameplay intelligence overhaul (uncommitted)

ROB now commentates developing match situations instead of narrating
visible objects, on branch `feature/commentary-refinements`. A new
in-memory `gameplay-v1` interpretation layer (`state/gameplay.py`)
reads the previously unused `observation-v2` structured keys into
observed/inferred signals plus cautious exact-label entity tracks
(occlusion/reappearance/movement; unknowns never linked), keeping
observation, interpretation, and confirmed event separate. Event
detection gains five additive candidate-only rules reusing the v1
boundary (`combat_engagement` across 2+ timestamps in 15s;
`knockdown_observed`, `revive_observed`, `blue_wall_use`,
`zone_pressure` on explicit first-sighting wording); kill-feed and
counter rules are byte-unchanged. Commentary gating adds the
`no-broadcast-significance` rule: scene/development claims need
gameplay wording, an entity-track change, or an event cite, so
standalone scenery, generic sightings, and HUD trivia stay silent
while gameplay developments and qualified echoes speak. Wording stages
receive a bounded match narrative (situation, engagements,
developments, uncertainties, already-said) as context-only input, and
the script validator now grounds analytical wording in structured
gameplay tags: knock/elim stems policed separately (tags never upgrade
a knock), action verbs per-stem with narrow engagement/movement
paraphrase allowances, and engagement/movement/zone nouns requiring
evidence or a matching tag. No new pipeline, paid call, or protocol
change: streaming windows, worker NDJSON, provider boundary, model ID,
TTS, and Electron untouched. Docs: new `gameplay-v1.md` contract,
extended `events-v1`/`commentary-v1`/`script-v1`/`observation-v2`
sections, ADR 0016. Known limits: engagement (15s) and reappearance
(6s) windows are tuning placeholders; live v2 field population still
unverified (no paid calls); real-footage acceptance not run (no
footage or key in this environment — instructions in the task
handoff).

Verification: 64 new offline fixture tests (`test_gameplay` 19,
`test_event_intelligence` 17, `test_significance` 12, `test_narrative`
16); full Python suite 779 tests with only the 3 pre-existing
full-run failures (Windows `con` path, api_activity leak, opening
already-emitted — all reproduce on the clean tree). Fixtures in the
commentary/script/streaming/writer/opening/terminology suites that
asserted trivial scene lines were updated to gameplay-bearing
wordings; old expectations preserved as suppression tests. Electron
suite (no Electron files touched): 608/617 with TEMP redirected into
the workspace (sandbox EPERM blocks os.tmpdir()); the 9 failures sit
in the documented pre-existing set (TTS preview, export, toast,
ffmpeg, media, branding).

## Temporal gameplay event intelligence (uncommitted)

Additive multi-observation patterns on branch
`feature/commentary-refinements`: `observation-v2` (v1 core plus
optional verbatim-only `subjects`/`action`/`spatial`, per-version
strict validation, mixed-directory support), two new detection
rules (`elim_streak`: 3+ same-team strictly-increasing Elim
readings within 30s; `feed_cluster`: 2+ feed-satisfying
observations within 10s with disjoint name tokens), computed
significance ordering, and one echo-like `event_sequence`
commentary template (type stays `event_echo`, so qualifier,
uncertainty, confidence, token-subset, and containment rules
apply unchanged). No `events`/`commentary`/`script` schema bump,
no state/worker-protocol/TTS/Electron change; pairwise events
still fire alongside sequences; streaming words sequences once
across windows via stable claim ids. Docs: new
`observation-v2.md` contract, new rules/template sections in
`events-v1.md`/`commentary-v1.md`/`script-v1.md`, ADR 0015,
roadmap 5.1. Known limits: window thresholds are tuning
placeholders; live v2 field population unverified (no paid
calls); v1-vs-v2 rewrites force `--rebuild-state` by design.

Audit-fix refinements (same branch, uncommitted): per-team-scope
elim pairing and streak chains (another team's interleaved counter
neither joins nor blocks a team's chain); feed clusters worded as
candidate groupings (disjoint names do not prove distinct entries);
multi-source confidence is the weakest contributing label at
detection, capped at the weakest cited fact at gating, and the
validator enforces the contract direction (a line is never stronger
than any cited source); streaming halt stops paid windows and
synthesis without draining, and failed windows release unworded
claims for later windows. No schema bump: same shapes, enums, and
consumers; `events-v1.md` wording updated explicitly for the
corrected derivations.

Verification: 69 new offline fixture tests across schema,
detection, commentary, writer, script, and streaming suites
(58 temporal + 11 audit-fix, each failing pre-fix);
full Python suite 715 tests with only the 3 pre-existing
full-run failures (Windows `con` path, api_activity leak,
opening already-emitted — all reproduce on the clean tree).
Electron suite (no Electron changes): 610/617 pass with a writable
temp dir; 7 pre-existing failures in untouched areas
(TTS preview, export, toast, ffmpeg, media, branding).

## Finish-later dismissal + crash-forensics lifecycle (uncommitted)

Finish Later is now a persisted dismissal, not a bare navigation: the wizard
exits through `exitSetup` (persists `onboarding.dismissed` before navigating,
stays + errors on save failure), startup routes on `shouldShowOnboarding`
(completed or dismissed hides the wizard), and Preferences replays from either
state via `setupTogglePayload`. Dismissal never marks provider/model verified.
Forensics for the affected-machine exit-132: renderer lifecycle milestones
(wizard exit, persist, navigation, dashboard mount/hydration) flow through a
new allowlisted `diagnostics-report` IPC into the bounded userData log;
`worker.start` is recorded main-side; the ready snapshot gains CPU model and
Linux instruction flags. The native SIGILL itself was not reproduced here
(this container kills Electron pre-ready) and no native fix is claimed; the
added trail pinpoints the crash phase on the next affected-machine run.

Verification: Electron suite 616/617 (only the known pre-existing toast
failure); dismissal/routing/payload logic covered behaviorally; transition
verified in a jsdom harness with the real settings store (dismiss persists,
reload lands on dashboard, full trail, max 1 active subscription, no errors);
Vite build + forge-start main boot pass.

## Exit-133 crash investigation + diagnostics persistence (uncommitted)

Not a crash fix: the reported renderer crash (exit 133) was not reproduced
here, so no crash-behavior change is claimed. Local finding: stock Electron
36.9.5 cannot boot its browser process in this container at all (SIGTRAP
pre-ready in 12/12 flag configurations, including single-process and
no-sandbox) — a stricter, earlier failure than the reported one, where main
boots and the renderer dies. Deduction from the user screenshot: the crash
page itself renders, so renderer spawn works there and the trigger is
content-specific (native crash; JS exceptions cannot kill the process). GPU
remains an unconfirmed hypothesis. Shipped instead: a bounded JSONL
diagnostics log under userData (`main/diagnostics-log.mjs`, secret-scrubbed,
rotated, no-throw) recording app-ready environment snapshots (versions,
platform, GPU feature status, crash-dumps path), window/child-process/crash/
load/retry milestones; local-only crashReporter (no upload); separated
failure screens (dev-load, packaged-load, renderer-crash, crash-exhausted
with diagnostics path); explicit manual retry via an intercepted
`rob-retry://` navigation that resets budgets only on user action.

Verification: Electron suite 600/601 (only the known pre-existing toast
failure); new diagnostics-log (8) + new recovery tests pass; Vite build
passes; forge start boots the real main process. Real renderer-crash and
packaged-build verification still require the affected machine; exact
repro/diagnostic commands are in the task handoff.

## Blank-window recovery audit (uncommitted)

Renderer failure handling completed around the committed ErrorBoundary and
load-retry work (kept intact): `render-process-gone` now logs reason + exit
code and reloads the same window in place (duplicate-suppressed, lifetime
cap of 3, crash page after exhaustion); `unresponsive`/`responsive` emit
diagnostics only and never destroy a busy renderer; `app` `child-process-gone`
(GPU, utility, ...) logs type/reason/exit code via `main/process-events.js`
with no automatic GPU or helper action; scheduled load retries re-check
destruction before firing. Recovery never creates a second window and never
touches the Python worker or project state. Pre-existing failure (verified at
clean HEAD, unrelated): `editor-export` "toast notifications have exactly four
owners" — ProjectCreationDialog is a legitimate fifth sonner owner.

Verification: Electron suite 584/585 (only the pre-existing toast failure);
new `renderer-recovery` behavioral tests (11) pass; window retry/overlay tests
intact; Vite renderer build passes; forge start boots the real main process.
Renderer crash/load-failure paths verified via event mocks only — real Electron
GUI reproduction is impossible in this container (GPU/zygote SIGTRAP).

## ROB app icon + terminology isolation (uncommitted)

Supplied waveform icon integrated: `electron/src/assets/icons/icon.{png,ico,icns,svg}`
(renamed from `svgviewer-output.*`, design untouched). Forge `packagerConfig.icon`
+ per-maker icons (squirrel setupIcon, deb/rpm png, macOS via packager icns) and
`BrowserWindow` icon via dev/packaged-aware `windowIconPath()` (extraResource png);
no tray exists so no tray wiring. Terminology: COD script rules fixed
("confirmed kill, knock" → "confirmed kill, elimination"); script validator stems
extended so invented finish/flush, blue/red zone, Booyah, and chicken-dinner claims
are rejected without evidence (no evidence-rule weakening). Resolution fallback
(unknown game → Free Fire default) kept as the documented intent; invalid explicit
packs keep failing loudly; custom overlays stay per-pack scoped. Supersedes the
"no logo asset / icon wiring still open" note below.

Verification (relevant only): Python terminology-isolation (23), prompt-packs (34),
script (22), opening (31), commentary-writer (21), streaming (24), worker (36) pass;
Electron app-icon (9), window (8), prompt-packs (14), rob-brand (11) pass. No paid
calls; no native Windows/macOS packaged build run yet.

## ROB reliability + rebrand milestone (uncommitted)

Audio lifecycle: run state carries a monotonic `runSeq` and the TTS
manifest freshness gate now takes a run-started flag — a new run
immediately invalidates the previous manifest and shows live
`u-*.wav` segments until its own generation lands; idle/hydrated
views keep showing the latest persisted audio; project switches
clear the view; latest listing wins. Opening lifecycle: the opening
claim id is scoped to a per-process `AI_COMMENTATOR_RUN_ID`, so a
new run always gets its own introduction even with identical
metadata, while same-run retries still suppress duplicates; the
sequential path now writes an opening-only success document (valid
for TTS) instead of silence when gameplay claims are empty but
project metadata exists. Terminology: Blue Wall is the canonical
Free Fire cover term across vision/script/writer prompts (Gloo
Wall kept once as the item alias in game context); no leakage
into BGMI/COD (tested). Rebrand: user-facing copy is ROB /
Real-time Observer & Broadcaster / ROB Studio; NO ROB logo asset
exists in the repo (swept; only a dashboard photo and third-party
assets found), so no mark was invented — logo design plus icon
wiring is still open. Note: unrelated worktree deletions of three
nav sections found during this milestone were reverted as
out-of-scope. Prior "Blue Wall not adopted" note below is
superseded by this milestone.

Verification (targeted only): Python opening/pack/script/
streaming-subset/worker-TTS suites pass; Electron audio/tray/
session/brand/titlebar/dashboard/onboarding suites pass. No paid
calls made; no live E2E run yet.

## Commentary pipeline refinements (uncommitted)

Game-aware commentary, session openings, and reliable audio-tray
delivery. Null `promptPackId` now maps from the project game
(bgmi→bgmi, cod→cod, free-fire→free-fire) instead of always
defaulting to Free Fire, main-side and Python-side with explicit
selection preserved. One project-aware opening introduction is
worded per session at audio timestamp 0 from structured game
metadata (new additive `game.metadata` run snapshot; LLM wording
with a deterministic verbatim-field fallback, once-per-session id
suppression, validated by the standard script gates). Pack
wording extended with canonical-only terms (heals/boosts,
character skills, lethals/tacticals, Winner Winner Chicken Dinner
as a confirmed-victory-only phrase, stronger stream-presentation
exclusions); no cross-game leakage (tested). Audio-tray
reliability: the tray refetches on `stage_completed` (closes the
streaming `u-*.wav`→`segment-*.wav` rename gap and populates
sequential runs at TTS stage end), tracks the run's TTS
`generation_id` (new additive `stage_completed` tts detail) so a
stale manifest never shadows live segments, clears the view on
project switch, and commits only the latest listing. Continuity:
script prompts carry evidence-derived intensity
(low/medium/high/critical), and NORMAL gameplay utterances now
pre-empt queued LOW general commentary (HIGH still pre-empts all;
in-flight audio never recalled). Schemas, gates, validators, and
the NDJSON event set untouched; evidence/factuality behavior
unchanged. Known limits: in-flight (unfinalized) utterances stay
invisible across a mid-run reload until the manifest lands;
sequential runs show rows at TTS stage end, not per segment;
"Blue Wall" was not adopted (no glossary entry; Gloo Wall stays
canonical per packs/tests). [Superseded by the ROB milestone
above: Blue Wall is now canonical.]

Verification (targeted only): Python opening/pack/script/
streaming-subset/worker-TTS suites pass; Electron
audio-rows/worker-view/workspace-sessions/project-config/
prompt-packs suites pass. Manually unverified: live run quality
and voice (no paid calls made).

## Prompt-pack rebuild + match-context integration (uncommitted)

All three factory packs rewritten in place (same 14 field keys,
metadata, version): gameplay-vs-presentation vision rules (face
cams/OBS/chat/overlays/menus excluded; HUD may support a fact,
never a standalone observation), concise per-game references (Free
Fire Gloo Wall/knock-secure/Clash Squad/Booyah; BGMI
knock-vs-finish/blue zone/airdrops; title-generic CoD
operators/Hardpoint hill/dog tags/streaks), broadcast spoken style
with varied openings and restrained fillers, strict evidence rules
kept, and verified-context continuity blessed over dead air. No
cross-game term leakage (tested). Project match details now reach
every wording stage: Electron composes populated-only context
(Mode/Match/Map/Category/Tournament/Stage/legacy Teams, labeled
Notes; category/tournament/stage are newly integrated), and Python
labels static reference vs project details in vision, script, and
writer prompts (script/writer previously got none). Schemas, gates,
validators, and provider contracts untouched. Continuity verdict:
scene claims already let quiet windows speak from verified context,
but per-segment WAVs with no stitching or gapless scheduler mean
zero-silence is NOT guaranteed; no playback refactor proposed here.

Verification (targeted only): Python prompt/script/writer/
streaming/schema/adaptive/batch suites pass (258/258, exit 0);
Electron project-config/prompt-packs/processing pass (58/58).
Renderer/main/preload vite builds currently fail on pre-existing
tree issues unrelated to this change (renderer.jsx imports
undeclared, uninstalled `@fontsource/inter`; main config resolves
the renderer entry) — reported, not fixed here. Manually
unverified: commentary quality and voice in a live run (no paid
calls made).

## Typography refinement — Sora + Geist Mono (uncommitted)

Product typography is now Sora (UI) + Geist Mono (technical layer).
`@fontsource/inter` replaced one-for-one with `@fontsource/sora`
(same 400/500/600/700 weights; minimal package.json/lock diff, no
other install collateral); `renderer.jsx` loads Sora + the unchanged
Geist Mono 400/500, and `--font-sans` points at Sora with the
previous system fallback stack. Audit found no component-level font
overrides and `font-mono` already applied consistently to technical
metadata app-wide, so no component sweep was needed. Hierarchy
alignment per the type table: hero headline to 700, sidebar
navigation to 500 (buttons already 500, headings/project names
already 600, body 400). Self-hosted only — no runtime webfont
requests. Docs synced (`DESIGN_SYSTEM.md`, `UI_ROADMAP.md`).

Verification: renderer production build succeeds; bundle contains
Sora 400–700 and Geist Mono 400/500 woff/woff2 with zero Inter
files. No typography tests exist in the repo, so none were run; no
behavior, spacing, color, or layout changes. Not manually verified
in a running shell (clipping/wrapping/weight feel across dashboard,
editor, settings, dialogs, sidebar).

## Monochrome cinematic dashboard refinement (uncommitted)

Focused visual pass over the broadcast-workspace dashboard. The
`--live` violet token is fully retired (its only consumer was the
hero; verified no other usage) and removed from `index.css` and
`DESIGN_TOKENS.md`, which now states the dashboard is strictly
monochrome. `LiveCommentaryHero` is now the cinematic centerpiece:
same `esports-setup.webp` asset, grayscale, `object-cover` with a
documented 50%/38% focal anchor (keeps the gamer's headset and the
match monitor in frame at banner aspect ratios), strong black
horizontal gradient, fixed 250px desktop / 300px narrow height,
left-aligned editorial composition (LIVE COMMENTARY eyebrow +
outlined COMING SOON badge, "Every moment. Every play. Live."
headline, original subtitle), static and non-interactive. The banner
moved directly below the greeting so project count never buries it.
Library scalability: the grid renders the 6 most recent projects
inline (backend sort by last-opened preserved) with an accessible
View All / Show Less toggle for the rest — no dedicated library view
exists, so in-place paging was chosen over a new view or a
virtualization dependency; hidden cards never mount, so their
thumbnails never load (stats still aggregate all listings honestly).
Quick Actions gained a primary white Import button; stats slimmed to
strong white numerals; project cards and the monochrome sidebar
indicator unchanged. Scrolling unchanged: the App content wrapper
owns the single vertical scroll, no nested scroll containers added.

Verification (targeted only): rewritten/extended `dashboard` guards
plus `dashboard-stats`, `navigation`, `renderer-hooks`,
`project-deletion`, `format` pass 85/85; renderer production build
succeeds with the new copy confirmed in the bundle and the retired
violet hex absent from the CSS. No Python, IPC, schema, worker, or
editor changes. Manually unverified in a running shell (all visual
states: empty/single/many projects, narrow widths, reduced motion).

## Dashboard redesign — Obsidian broadcast workspace (uncommitted)

Dashboard rebuilt as a premium broadcast workspace: a "Welcome back"
greeting, three honest stat cards (Projects, Analyses, Commentaries —
new pure selectors in `lib/dashboard-stats.js` over `listProjects` plus
one `listArtifacts` pass per project; unconfirmed output is omitted,
never invented), the library as media cards (first extracted frame via
the audited `project://` frames scope with lazy loading and a Film
fallback, name, filename, size, status, last-opened, artifact chips,
current-project badge, identical open/delete behavior), a Quick Actions
panel (Import gameplay → creation dialog; Run AI analysis / Generate
commentary → latest project editor, or the import dialog when empty),
and the live-commentary photo banner moved to the bottom
(`LiveCommentaryHero`: `esports-setup.webp` via Vite import,
readability gradient, one static violet wash, non-interactive). Engine
status stays solely in `AppHeader` (live `useWorkerStatus`); the
sidebar gained only a selected-item indicator. One new `--live`
(`#A78BFA`) token, synced in `DESIGN_TOKENS.md`; no new dependencies,
no IPC/schema/Python/worker changes, no editor changes. Header
waveform deliberately omitted (clutter without function).

Verification (targeted only): new `dashboard-stats` (6) plus rewritten
`dashboard` guards, `navigation`, `renderer-hooks`, `project-deletion`,
`project-store`, `format` pass (99/100; the one failure is the known
sandbox EPERM rename flake in untouched `writeAtomic` code);
`processing` shows only the same EPERM flake (7 EPERM failures, 16
pass); `editor-export` toast-ownership guard still fails on Windows
path separators plus files this change never touched (pre-existing —
no new sonner owner added); renderer production build succeeds with
the new copy and fingerprinted photo confirmed in the bundle. Manually
unverified: card/banner feel, thumbnail loading, and narrow widths in
a running shell.

## Creation dialog + 3-game catalog + recording dropzone (uncommitted)

Creation is a dedicated `ProjectCreationDialog`: project name, a
central single-recording dropzone (vendored Kokonut UI File Upload,
adapted to Obsidian tokens; drop/pick/paste, one file, extension
mirror of the main-process validator), game selection, and a
game-aware `GameMetadataForm`. A browse-files fallback keeps the
native picker path; submit sends only `file.path` to the unchanged
`createProject` IPC (main still imports/copies), gates on name plus
recording, single-flights, and stays open on import failure so a
project never appears created when its recording import failed.
The catalog (`electron/src/lib/games.js`) owns exactly Free Fire,
Call of Duty (generic), and BGMI with per-game match types, modes,
maps, and categories. `configuration.game` gains `category`,
`tournament`, and `stage`; normalization validates bounds only and
migrates legacy values idempotently — but `composeGameContext` is
deliberately unchanged, so new fields persist without reaching AI
prompts yet. Configure edits the same shape (multi-game summary);
no worker/prompt/TTS change.

Verification (targeted only): new `games` suite plus
extended/rewritten `project-config`, `dashboard`, and
`renderer-hooks` suites pass (79/79, run with TEMP redirected:
sandbox EPERM blocks `os.tmpdir()`); renderer production build
succeeds. Follow-up fix: dropped/picked recordings failed with
"Couldn't read this file's path" because Electron 32 removed
`File.path` from the renderer (app runs Electron 36) — paths now
resolve through a sync `getPathForFile` preload bridge
(`webUtils.getPathForFile`), used identically on drop-accept and
drop-success; dialog widened to `sm:max-w-2xl` with looser grid
gaps; match type/mode/category selects migrated to the shared
shadcn Select (legacy-value item and None-to-clear preserved; map
stays free-text input with datalist). New `preload-bridge` suite;
83/83 across the focused set; renderer build succeeds. Simplified
again: the dropzone is gone — creation is a compact `sm:max-w-md`
dialog (name, game Select with stable ids, optional match
type/mode/map, single Add video picker with filename +
Replace/Remove, no teams; category/tournament/teams/notes stay in
Configure). Kokonut File Upload deleted, `getPathForFile` bridge
reverted, extension mirror removed; `gameInputToRecord` reused for
the blanks→null contract. Focused suites (`games`,
`project-config`, `dashboard`, `renderer-hooks`, new `game-form`)
pass 79/79; renderer build succeeds. Manually unverified: dialog
feel, picker flow, and Configure editing in a running shell.

## Project-owned game configuration (uncommitted)

Game Profiles and Commentary Presets are removed as user-facing
systems: no library pages, nav entries, selectors, stores, hooks, or
IPC — `game-store.mjs`, both settings sections, `useGameLibrary`, and
their tests are deleted. Each project owns its game metadata in
`project.json` (`configuration.game`: fixed `free-fire` id, optional
mode/match type/map/language/teams/additional context), collected by a
shared `GameMetadataForm` in the Dashboard creation flow ("Match
details (optional)") and editable in the editor Configure tab, which
keeps vision + prompt-pack selection and drops the style section.
Run resolution builds the unchanged worker `{game, prompt}` snapshot
from owned metadata (structured context composition; built-in
Esports/energetic voice; project language), so no Python change was
needed and default runs behave byte-identically. Legacy
`gameProfileId`/`commentaryPresetId` configs migrate on read (custom
context and language survive; unresolvable refs fall back to
defaults; never breaks loading; idempotent; persisted on next save),
`game-library.json` is never written or deleted, and Prompt Packs,
TTS/Voice, credentials, and the worker protocol are untouched.
Onboarding is four steps (style step removed; stored step 4 clamps to
done); `vault-migration` keeps credential migration only.

Verification (targeted only): rewritten/extended `project-config`
(17), `onboarding`, `onboarding-wizard`, `vault-migration`,
`vault-ipc`, `settings-sections`, `renderer-hooks`, `config-display`,
`dashboard`, `project-store`, `processing`, `settings-ipc`,
`voice-config-ipc`, `tts-ipc` suites pass (216/216 across the
affected batches, run with TEMP redirected: sandbox EPERM blocks
`os.tmpdir()`); renderer production build succeeds. One transient
failure during verification was traced to a concurrent edit of
`ApiKeysSection.jsx` by the other active agent and passes on rerun.
No Python tests run (no Python-facing change). Manually unverified:
creation-flow feel and Configure-tab editing in a running shell.

## Unified API diagnostics + live processing pipeline (uncommitted)

Every outbound AI request is now tracked at the call boundary and
shared by two surfaces. Python captures paired started/terminal
events (`ai_commentator/api_activity.py`) in the raw Baseten paths,
all three vision adapters (single, adaptive, HIGH batch), the
commentary/script writer (purpose-tagged), and per-utterance TTS
synthesis; `worker.py` drains them as validated `api_activity` NDJSON
after every protocol message. The main process pairs, persists
(per-project `api-activity.json`, 200 records; settings-level file,
100), and forwards them; worker exit/quit force-flush, restarts
reconcile in-flight requests as interrupted, and deletion drops the
scope. Settings-level checks (connection, image/TTS verification,
model discovery, voice previews) record completed entries main-side.
Malformed activity lines downgrade to log notes and can never fail a
run; secrets and image payloads are redacted at capture and again at
persistence. The Diagnostics dialog gains an API Activity tab
(summary, scope toggle, expandable requests) beside the untouched
Artifact Browser; the Processing tab replaces the stage loader with a
live pipeline (observed stages only, expandable counts, sampling
inside vision, inferred TTS skipped/queued states, streaming-overlap
aware). Edited files were normalized CRLF→LF (diff-neutral under
autocrlf); no protocol/IPC contracts changed beyond the additive
`api_activity` message and `get-api-activity` bridge.

Verification (targeted only): new `test_api_activity.py` (18) plus
`test_providers`/`test_adaptive*`/`test_commentary_writer`/
`test_script`/`test_tts`/`test_vision_batch`/`test_streaming`/
`test_worker`/`test_custom_provider` pass; new Electron
`api-activity` (13), `api-activity-view` (15), `diagnostics-wiring`
(5) suites pass with extended `worker-protocol`, `python-worker`,
`workspace-sessions`, `tts-ipc`, `vault-ipc`, `format` coverage
(239/239 in the affected set, run with TEMP redirected into the
workspace: sandbox EPERM blocks `os.tmpdir()` for all suites);
renderer production build succeeds with the new surfaces in the
bundle. Manually unverified: live request streaming, dialog/pipeline
feel, and hydration timing in a running shell.

## Editor Voice tab + reusable voice configurations (uncommitted)

The editor inspector gains a fifth Voice tab (VoicePanel, after Script): project-owned voice editing (TTS credential, catalogue model/voice, delivery style) with draft/save/discard, paid preview through the existing 	ts-preview channel and shared PreviewPlayer, and a reusable preset library (oice-configs.json, oice-config-* IPC) with apply-as-copy, save-new, update, rename, and two-step delete. Library entries carry credential references, never secrets; provider pins from vault metadata; catalogue membership and credential existence stay apply-time gates via the unchanged 	ts-config-set project path, so runs resolve identically. The new tab is inherently project-scoped and carries no scope selector; the standalone Voice Providers page is untouched. See docs/contracts/voice-configs-v1.md.

Verification: 20 new tests pass (store, IPC, panel guards) plus 52 relevant existing (tts-ipc, tts-config, renderer-hooks); renderer production build succeeds with the tab in the bundle. Full-suite editor-export toast-ownership guard fails in this sandbox on Windows path separators (pre-existing, unrelated — no new toast owners). Not manually verified in a running shell: tab feel, preview playback, and apply/save flows.

## Workspace persistence, HIGH multi-frame & default spoken audio (uncommitted)

Back navigation no longer destroys the editor: run state moved from
`WorkspaceSection` locals into a per-project session store
(`lib/workspace-sessions.js`, no new dependencies) fed by one
shell-owned worker subscription, so leaving the editor unmounts the
view (video/audio resources still release on unmount) while the
session keeps receiving events, and reopening restores the exact
state. First opens hydrate from persisted artifacts (manifest,
script, TTS entries plus listing counts) into stages, adaptive
samples, script segments with TTS join, and honest terminal states —
worker logs are not persisted and stay empty. Worker events carry the
run's `projectId` (additive main-side tag) for cross-project routing;
deletion disposes the session. HIGH adaptive sampling now analyzes
up to 3 consecutive frames in one request (strict `{"frames": [...]}`
validation reusing observation-v1/sampling validators, one request
counted, per-frame persistence/hooks unchanged) via new adapter batch
methods; NORMAL/LOW and adapter-less clients keep single-frame
behavior, and the baseten runtime path now uses `BasetenAdapter`.
Spoken audio is default: the checkbox and `requestTts` are gone, the
main process attempts TTS for every script/streaming run and reports
`{enabled, reason}` on accept, the inspector shows Automatic plus a
configure note when skipped, and sequential TTS failure no longer
fails the run (commentary kept, `tts: error` recorded).

Verification (targeted only): new `workspace-sessions` (9) and
`test_adaptive_batch` (14) suites pass; `test_adaptive`,
`test_providers`, `test_worker` (35), `test_streaming`,
`test_control` pass; Electron `processing`, `run-options`,
`worker-view`, `renderer-hooks`, `export-ipc`, `dashboard` pass
(120/120 in the affected set); renderer production build succeeds.
Not manually verified in a running shell: Back/reopen feel,
hydration loading state, HIGH batch live behavior, and TTS
skip/failure messaging.

## Reliable project deletion & premium window chrome (uncommitted)

Root cause of the Windows deletion bug was reproduced with a real
exclusive file lock: `deleteProject` ran a single non-atomic
`fs.rmSync`, so a locked `gameplay.mp4` failed midway (EBUSY/EPERM),
left `project.json` deleted, and every retry reported `Project not
found` while orphaned bytes stayed on disk. Lock owners: the Chromium
media pipeline (`VideoPreview` had no element-detach cleanup) and
export FFmpeg (the delete guard only checked the Python worker).

Deletion is now a lifecycle: the store quarantines via one atomic
same-filesystem rename into `projects/.deleted/` (excluded from
listings) with a `tombstone.json`, retries transient codes
(EBUSY/EPERM/ENOTEMPTY/EACCES) with bounded exponential backoff, and
reports logical success at the rename — physical cleanup failures
keep the tombstone with a bounded background retry chain plus a
startup sweep (`sweepDeletionQuarantine`, wired in `main.js`).
Per-project in-memory locks serialize concurrent requests; a repeat
delete of a quarantined id returns idempotent success instead of
`Project not found`. IPC keeps its `{ok, deleted, id}` contract (plus
`cleanup`/`alreadyDeleted`), refuses while the worker is busy
(unchanged), refuses while that project's export runs (new
`activeProjectId` on the export manager), and refuses
open/update/process/export for a project being deleted. The renderer
releases video elements on detach (pause, clear src/srcObject,
`load()`), clears a deleted open workspace via `onProjectDeleted`,
and keeps the typed-name dialog, single toast, and row-exit motion.

The white native title bar is replaced with integrated Obsidian
chrome: `titleBarStyle: 'hidden'` + `titleBarOverlay` (surface
`#101011`, symbols `#f1f1f1`, height 36) on Windows only, dark
`backgroundColor` everywhere, and a new `TitleBar` layout component
(drag region, studio mark, section context, Windows caption spacer,
no interactive elements) rendered above the shell and onboarding;
the sidebar brand row was removed to avoid a duplicate header.
Security settings, maximization lifecycle, and preload/IPC
boundaries are unchanged; no new dependencies.

Verification: new `project-deletion` (16), `titlebar` (7), and
`media-release` (4) suites pass; rewritten `window` plus extended
`dashboard`/`navigation`/`export-runner`/`renderer-hooks` suites
pass; renderer production build succeeds with the new chrome in the
bundle; main files pass `node --check`. One environmental failure
recurs in this sandbox (EPERM on rapid `project.json.tmp` renames in
untouched `writeAtomic` code; reproduced identically on pristine
HEAD). No live walkthrough was possible: Electron cannot initialize
Chromium in this sandbox (bare `whenReady` probe crashes), and Forge
cannot bind a dev server — manual Windows steps are in the handoff.

## Project deletion UX, maximized startup & nav icons (uncommitted)

Deletion is now a deliberate typed-name confirmation: clicking a
project's delete icon opens a compact `Dialog` (shared primitives,
`Delete project?` title, exact caution copy) asking for the complete
project name — case-insensitive, trimmed — with the destructive action
disabled until it matches and a `Spinner` + `Deleting…` pending state.
One `deleteProject` IPC call per confirmation (ref + state
single-flight guards); success drops the row immediately
(`AnimatePresence` exit, opacity + 12px slide on
`MOTION.fast`/`EASING.entrance`, exiting row only, no cascade) with a
stable-id `Project deleted` toast, then reconciles via `listProjects`
without ever reporting a refresh failure as a deletion failure.
Failures keep the dialog open with typed input intact for retry/cancel
and report through a `Could not delete project` toast; deletion no
longer touches the global `flowError` alert. No `Input` primitive
exists in `components/ui/`, so the confirmation field reuses the
native token-styled input pattern with a proper associated label. The
shell now launches maximized: `createMainWindow` starts hidden
(`show: false`, same 900×650 fallback size and secure webPreferences)
and maximizes + shows on `ready-to-show` (destroyed-window safe, no
fullscreen/kiosk). Sidebar Dashboard moved from `Clapperboard` to the
already-imported `LayoutDashboard`; Editor keeps `Clapperboard`. No
IPC, schema, Python, worker-protocol, token, or dependency changes.

Verification: relevant Electron suites 60 tests pass, 0 fail (offline,
`node:test`: rewritten `window.test.mjs` lifecycle tests, new
`navigation.test.mjs` icon guards, extended `dashboard.test.mjs`
dialog/matching/toast/exit guards, plus the untouched
`renderer-hooks` and `settings-sections` suites); renderer production
build succeeds with the new dialog copy confirmed in the bundle and no
`armedDelete` remnants. Manually unverified: dialog feel, toast
timing, row-exit motion, maximized first paint, and the reduced-motion
walkthrough in a running shell.

## Dashboard redesign — live AI commentary first (uncommitted)

Dashboard rebuilt around the product vision: a compact heading row, a
dominant static Live AI Commentary hero (`LiveCommentaryHero`: Coming
soon badge, "Every moment. Every play. Live." headline, suggested
description, three capabilities with Radio/Brain/Mic icons, one subtle
static token-derived radial wash, no actions or fake metrics), then
the recorded-gameplay library. The library collapses through the
editor's existing Animate UI `AutoHeight` primitive (same import path,
`deps`, and `MOTION.standard`/`EASING.entrance` transition as
`ProcessingInspector`) — note: no "auto-hide" component exists in the
repo or in `@animate-ui/react` 2.4.2, so `AutoHeight` height-disclosure
is the reused pattern. The header row (chevron toggle with
`aria-expanded`/`aria-controls`, heading, mono project count, Plus
"Add Video") stays visible when collapsed; Add Video also appears in
the empty state. Project IPC semantics are unchanged (native picker,
naming, isolated copy, open on success, silent cancel, inline
recoverable errors, two-step delete); same-tick re-entrancy refs were
added to add/create/delete. Loading shows a structural skeleton, list
errors gained a working Retry, and project create/delete successes
report through stable-id Sonner toasts (failures stay inline-only, so
no notification duplicates). The dashboard `WorkerStatus` card is
removed; the `AppHeader` pill is the sole worker indicator and
`WorkerStatus.jsx` is currently unrendered. No Python, IPC,
store-schema, Editor, or dependency changes.

Verification: Electron suite 393 tests pass, 0 fail (offline,
`node:test`, incl. new `dashboard.test.mjs` static guards, two new
hook-guard entries, and the toast-ownership guard extended to three
owners); renderer production build succeeds with hero copy and the
radial wash confirmed in the bundle. Manually unverified: all visual
states in a running shell (zero/multiple projects, hero, collapse,
toasts, narrow widths, reduced motion) — no display is available in
this environment.

## Processing workspace redesign + unlimited requests (uncommitted)

Processing tab rebuilt around real lifecycle state; the vision-request
limit contract is now `null` = unlimited (the default) with explicit
1–10000 bounds, propagated through renderer, run-options, main argv
gate (which now also enforces the upper cap it previously skipped),
worker/CLI passthrough, and the adaptive engine (loop skips the
max-frames check when unbounded; manifest records `max_frames: null`).
No numeric fallback exists anywhere: invalid renderer input blocks
Start with inline guidance, and main/Python reject invalid explicit
values. Termination for unlimited runs is structural (video end, stop,
first failure — scheduled timestamps strictly increase). The legacy
`ADAPTIVE_DEFAULT_MAX_FRAMES = 60` constant is retained for facade
compatibility only and drives nothing.

UI: ready state (mode/limit/TTS summary, incomplete-config guidance
with Configure link, advanced-settings path), hero current-stage card
(`AITextLoading` on the real stage label), `AILoadingState` steps
derived from observed stages only (new honest `skipped` status; no
pending invention; conditional script/tts appear only when the worker
reports them), sampling activity in `ScrollFade` with an unbordered
idle placeholder, collapsible worker-log diagnostics, and full
empty-state coverage (idle/starting/cancelling/failed/cancelled/
stopped/no-observations). RunPanel keeps terminal/result/error/starting
blocks plus stopped/cancelled stage history (`showStages` prop) so
stages never render twice. Sonner lifecycle audited: stable run toast
id per project was already correct; export toasts gained a stable id
so repeats replace instead of stacking. Export was already correctly
placed in the Editor toolbar — verified, unchanged. No original-audio
checkbox exists (game audio always ships in export; the Configure
checkbox is the paid TTS opt-in), so nothing was removed per the
audio-scope boundary.

Verification: Electron suite 382 tests pass, 0 fail; Python suite 526
tests pass, OK; renderer production build succeeds. Manual visual
verification in a running shell was not completed (cut short per
operator request after Xvfb proved unusable in the sandbox and before
the CDP screenshot pass ran). Unverified visually: every redesigned
surface — ready/failed/narrow/reduced-motion states, sampling
activity, toasts, Export toolbar. Not verifiable without a live
provider regardless: active-processing stages, completion/success
toast, and export progress over a real file.

## Configuration UX redesign C1–C5 + custom provider (uncommitted)

Complete configuration-experience redesign over preserved backend
contracts, plus one genuine backend addition: a user-configured
OpenAI-compatible `custom` vision provider (see
[ADR 0014](decisions/0014-custom-openai-compatible-provider.md)).

C1 onboarding: first launch renders a resumable 5-step guided wizard
(`OnboardingWizard`: welcome, provider, model, commentator style,
summary) instead of redirecting to settings. Progress persists to
`settings.json` `onboarding: {step, credentialId}` (tolerant reads,
legacy files start at step 0); the in-progress credential is adopted
on resume, never duplicated. Completion requires a verified vision
credential plus a game profile and preset — saving alone never
completes — and optionally creates a first project with the setup
applied. TTS stays optional.

C2 providers: the API Keys page is now AI Providers (Meta, Baseten,
Custom, Gemini TTS) with one shared status vocabulary
(`lib/provider-status.js`: not-connected, saved, connected,
model-selected, vision-verified, needs-attention), inline validation,
skeleton loading, and a detail panel with separate test-connection /
verify-image actions. Custom records carry a validated public-HTTPS
endpoint (localhost/private blocked, curated records reject the
field); verification pins key version + model + endpoint, and
changing any resets it. Model discovery (`custom-models` IPC, live
`GET /models`) degrades honestly to manual entry with
`discovery_unsupported`. Keys stay main-side encrypted; discovery and
verification never run automatically.

C3 Configure: the editor inspector is a compact overview (AI vision,
game profile + prompt pack, commentary style, processing, readiness
summary via `isRunReady`). The nested management dialogs are gone:
"Manage …" links navigate to the owning settings section with the
workspace preserved and a back-to-editor return.

C4 libraries: Games & Prompts is split into Game Profiles and
Commentary Presets sections over one shared `useGameLibrary` hook
(same IPC, IDs, and storage; built-ins immutable; reference-guarded
deletes). Profiles gain duplicate; presets gain a sized editor dialog
and an honest preview (deterministic prompt wording plus a labeled
style-illustration template, never presented as model output).

C5 settings: sidebar Configuration group is now Overview (new
read-only readiness page), AI Providers, Voice Providers (TTS Studio
content, unchanged behavior), Game Profiles, Commentary Presets,
Prompt Packs (kept: the pack editor has no other home), General
(Preferences content). Voice stays separate from vision; existing
remediation strings point at the new names.

Python: new `vision/providers/custom.py` adapter (plain Chat
Completions, request-time URL validation, minimal text connection
probe, shared live image probe, bounded discovery) routed through
`provider_setup.py` and every engine live-client site (batch,
adaptive, writer, script); `AI_COMMENTATOR_BASE_URL` reaches the
worker only for custom runs. Meta/Baseten behavior, catalogues, and
the legacy `BASETEN_*` fallback are unchanged.

Verification: Electron suite 377 tests pass, 0 fail (offline,
`node:test`, incl. new catalog/vault/IPC/discovery/onboarding/
status/validation/section suites and rewritten static guards for the
new structure); Python suite 519 tests pass, OK (offline, fakes only,
incl. new `test_custom_provider.py`); renderer production build
succeeds. No live provider calls were made; custom-endpoint behavior
against a real server (discovery shapes, redirect handling, image
probe acceptance) is untested beyond fakes. Manually unverified:
wizard walkthrough in a running shell, dialog/drawer feel at minimum
width, and the reduced-motion walkthrough.

## Editor refinement pass (on `feature/tts-generation`, uncommitted)

Polish on the existing three-region Editor; no structural rebuild, no
Python, protocol, schema, IPC, or security changes. Export moved from
the timeline header to the toolbar as the primary Editor action: a new
`hooks/useVideoExport.js` owns export state, the `export-event`
subscription, and export toasts, while `EditorCenter` computes the
audio-row join once and shares it with the timeline (no duplicated
discovery or rows). Eligibility, FFmpeg behavior, progress, cancel,
and done/error handling are unchanged; no output-reveal action was
added (no such IPC exists). The toolbar also gained a compact live run
status. The timeline was visually redesigned around the untouched
timing model: borderless regions with hairline boundaries and a center
baseline, quiet inactive bars, distinct active fill, memoized regions
(primitive props, so one decode no longer recomputes every path),
centered state ticks (waiting muted, generating amber, failed
red, decode errors honored), a playhead with a top marker, a
scroll-synced ruler with tick marks, and icon-led empty/unavailable
states. Inspector tabs gained icons with labels that collapse below
320px via container queries; script rows got timestamp chips, 13px
relaxed text, hover states, larger preview targets, and an icon empty
state, keeping the same segment/file mapping and streaming stability.
Pending run buttons now compose `Spinner`; native config inputs gained
focus rings; all buttons have a subtle `:active` press (disabled
under reduced motion); the splitter highlights while dragging; toast
ownership is exactly two modules (`useVideoExport` for export,
`WorkspaceSection` for one loading→outcome run toast with measured
counts, guarded against duplicates).

Verification: Electron suite 324 tests pass, 0 fail (offline,
`node:test`, incl. new static export-ownership/toast-ownership
guards); renderer production build succeeds; container-query CSS
verified in the built bundle. Manually unverified: visual polish in a
running shell, export progress/cancel from the toolbar, toast timing
and replacement, splitter/tab feel at minimum width, and the
reduced-motion walkthrough.

## Editor workspace redesign (on `feature/tts-generation`, uncommitted)

The Editor is now a three-region broadcast workspace: central gameplay
preview (untouched `VideoPreview` behavior), the commentary timeline as
the only bottom audio workspace (unchanged timing/playback/export
architecture), and a resizable right inspector with
Processing/Script/Configure/Project tabs. The Preview/Artifacts tabs and
the bottom Audio/Script dock are removed (`DockedWorkspace.jsx`
deleted); artifact browsing moved to a secondary Diagnostics dialog in
the editor header (same `ArtifactBrowser` IPC/contracts, video pauses on
open). The Script tab renders one readable list per segment — timestamp,
text, TTS status, and a compact play/pause preview toggle only when a
real WAV backs the row — reusing the shared `buildAudioRows` join and
`projectMediaUrl` helper. Audio discovery runs once per workspace
(`WorkspaceSection` owns `useProjectAudio`; the timeline and script
panel share its result), so both surfaces always agree. The inspector
splitter is dependency-free and accessible (`separator` role,
arrow/Home/End keys, double-click reset, 280–480px clamp, collapse
preserves tab state and scroll). Opening a project auto-collapses the
left navigation and restores it on exit; the sidebar stays manually
toggleable. New component usage: Sonner `Toaster` mounted once in `App`
(export done/failed toasts), `AITextLoading` for the live stage name in
the inspector, `AutoHeight` around the inspector status block. Animate
UI base Tabs were deliberately not adopted (`@base-ui/react` is not
installed; the existing shadcn Tabs are already Animate-UI powered) and
`AILoadingState` was left out (the `RunPanel` stage list already shows
the same real states). No Python, worker-protocol, schema, prompt,
provider, IPC, or security changes.

Verification: Electron suite 317 tests pass, 0 fail (offline,
`node:test`, incl. new `inspector-width` clamp/step tests and the
extended hook-import guard); renderer production build succeeds.
Manually unverified: sidebar collapse/restore feel, splitter drag
feel, dialog sizing on small windows, preview-audio overlap behavior,
and reduced-motion walkthrough.

## MVP video export (uncommitted)

The timeline header has an Export action that mixes timestamped
commentary WAVs over the source video into an MP4 (copied H.264
video, AAC stereo) via a bundled `ffmpeg-static` binary (7.0.2):
game bed at 0.8, commentary at 1.0, limiter ceiling 0.95, one input
per kept segment placed with absolute `adelay` offsets, output
capped at the probed source duration. Segment selection reuses the
timeline's shared single-channel overlap rule
(`selectSingleChannel`, equivalence-tested against live
`planPlayback`); only listed, stat-verified, RIFF-duration-parsed
ready WAVs are eligible. Main-side manager probes, spawns with argv
arrays, streams `-progress` percentages, and cancels with SIGTERM /
SIGKILL plus partial-output cleanup; one export at a time. New IPC
(`export-video`, `cancel-export`, `export-event`) plus matching
preload bridge follows existing validation patterns. FFmpeg ships
via npm in dev and `extraResource` beside the asar when packaged
(verified with a real `electron-forge package`: binary present,
executable, both resolutions correct). Renderer shows determinate
progress, cancel, and success/error states. No Python, schema,
prompt, or playback changes. Verified with unit, fake-process, IPC,
and real-ffmpeg integration tests — not yet manually verified with
real gameplay footage end to end.

## Synchronized commentary timeline (uncommitted)

The Preview tab now shows a compact waveform timeline beneath the
video: one region per generated speech segment positioned by its
`timestamp_seconds`, with real Web Audio-decoded peaks (96 per
segment, single SVG path each), a video-driven playhead, and
per-segment playback through one commentary channel scheduled
against `video.currentTime` (play/pause/seek/rate/ended aware, no
setInterval clock). Segments decoded after their start passed while
playing are missed for the pass and replayable after seek/replay;
overlaps resolve to the earliest starter; renames and decode gaps
never interrupt sounding audio. Timing assumption (no contract
change): evidence timestamps are already on the video clock, so they
serve as intended playback starts; generation time is never used.
No Python, provider, prompt, schema, or storage changes; the dock,
artifact browser, and video preview are untouched apart from shared
prop/format plumbing. Verified with targeted unit tests plus jsdom
harnesses with fake media boundaries — not yet manually verified
with real video/audio sync.

## Streaming audio visibility, playback & tray fix (on `feature/tts-generation`, uncommitted)

The pipeline wrote TTS audio under `output/audio/segments/` while
Electron discovered `<project>/audio/`, so generated segments were
invisible and unplayable, and the artifact browser had no audio UI at
all. `listArtifacts` now also lists `output/audio/segments/` (scope
`audio/segments`, served over `project://`), exposes the `tts`
manifest summary plus a readable `tts` artifact kind, and keeps the
legacy `audio/` roots for older projects. The artifact browser gains
an Audio tab (manifest entries with text/timestamps plus mid-run raw
files, each with a player and honest missing-file states), and the
bottom dock's Audio tab lists every segment as Waiting / Generating /
Ready / Failed / Skipped with per-segment playback while the run
continues (`Audio: X / Y ready`). The dock now uses two stable
always-mounted tab panels instead of one conditional panel, so
switching tabs no longer remounts subtree state, and a new
`tts_segment` `started` status distinguishes Generating from Waiting.
No pipeline, provider, prompt, or schema behavior changed.

## One-click processing simplification (on `feature/tts-generation`, uncommitted)

The workspace Configure tab no longer exposes pipeline-mode choices:
the "Streaming commentary" and "Final casting script" checkboxes are
removed, and streaming (with incremental script generation
underneath) is the standard experience via the
`buildProcessOptions` default. The only remaining run extra is the
"Generate spoken audio" checkbox (explicit paid opt-in, unchanged
main-side validation). Sequential mode, the `--with-script` worker
path, and all script/TTS schemas and artifacts are preserved as
internal fallbacks; no engine, TTS, or prompt-pack code changed.

## Game Prompt Packs + streaming commentary pipeline (on `feature/tts-generation`, uncommitted)

Game-specific Prompt Packs (Free Fire, Call of Duty, BGMI) plus an
opt-in streaming Vision → Script → TTS pipeline with incremental
script visibility.

Prompt packs: factory wording ships in Python
(`ai_commentator/prompts/`, exposed read-only via the offline
`python/prompt_packs.py` probe) and covers the adaptive vision,
script, and writer prompts with game-specific HUD/pace/context
wording; JSON shapes, gates, and validators stay in code and keep
enforcing correctness. User edits overlay individual fields in the
global custom-only `prompt-packs.json` (atomic writes); reset deletes
the overlay; empty text falls back to factory. Selection is per
project (`configuration.promptPackId`, null = `free-fire` default),
snapshotted main-side into `AI_COMMENTATOR_SETTINGS_JSON.promptPack`
and re-validated by Python before any paid call. The Prompt Packs
section (Configuration group) lists packages, shows every prompt with
factory/custom badges, and edits/saves/resets per field and per pack;
the editor Configure tab selects the project's active pack.
Pre-migration projects resolve byte-identical Free Fire behavior
(verified against HEAD output). See
`docs/contracts/game-pack-v1.md` and ADR 0012.

Streaming (`--streaming` + workspace toggle, default off; sequential
stays the default): the vision loop produces validated observations
into a bounded FIFO while one script thread words incremental windows
(one bounded LLM call each, same gating/validators) and one TTS thread
synthesizes utterances sequentially, over bounded in-process queues
with backpressure. Priority is app-side (echoes > developments >
scene); urgent utterances supersede routine ones still queued
(recorded, never silently dropped); in-flight synthesis is never
recalled. New NDJSON progress messages (`script_segment`,
`tts_segment`, validated main-side) feed a workspace Script dock
panel: incremental segment text, generation status, per-segment audio
status, and superseded/failed states, surviving terminals for
post-run review. Final `script.json`/`tts.json` keep the exact
sequential layout (sorted `segment-NNN` ids, segment-named WAVs via
atomic rename); synthesized bytes pass WAV validation first. Stops
and vision failures still finalize partials plus a best-effort
state/events/commentary tail. See the streaming sections of
`docs/contracts/worker-protocol.md` and ADR 0013.

Verification: Python suite 484 tests OK (new `test_prompt_packs.py`,
`test_streaming.py`, worker `--game-pack` cases; offline, fakes
only — including a mocked-vision overlap proof and a supersession
test); Electron suite 247 tests pass, 0 fail (offline, `node:test`);
renderer production build (`vite build` with
`vite.renderer.config.mjs`) succeeds. No live provider calls were
made. Standalone main/preload `vite build` invocation still fails on
the pre-existing empty-config alias issue (Forge builds them); `node
--check` passes on all changed main files. Streaming costs more paid
calls per run than sequential (one script call per window); manual
renderer steps (pack edit/save/reset round-trips, streaming run
progress, Script panel states) remain uncovered beyond the static
build.

## Temporary dev-only secure-storage bypass (on `feature/tts-generation`, uncommitted)

`credentials-store.mjs` holds an explicit-opt-in, unpackaged-only
fallback: when `safeStorage` is unavailable and the user enables "Allow
insecure development credentials" on the API Keys page, credentials
live in main-process memory only (`devOnly` records), work with
verification/preview/runs through the unchanged retrieval functions,
and vanish on disable or quit. Nothing is written to disk; production
builds reject enabling; bypass off preserves the original
secure-storage requirement. Multifactor coverage in
`electron/test/dev-bypass.test.mjs` plus a worker-env proof in
`processing.test.mjs`. Remove before any production release.

## TTS Studio (M7, on `feature/tts-generation`, uncommitted)

A dedicated TTS Studio sidebar section configures the commentary
voice: backend-provided catalogue (30 prebuilt voices, pinned models,
defaults, limits via the offline `python/tts_catalog.py` probe —
never a renderer copy), model/voice/delivery-style editors with
per-field inherited/overridden captions, TTS credential selection,
paid preview synthesis of a fixed phrase, and a custom-text test
bench. Preview audio returns base64 over IPC while temp WAVs are
deleted immediately; previews never touch project artifacts.

Configuration has two partial layers — global `settings.json` `tts`
section and `project.json` `configuration.tts` overrides — resolving
project override > global default > application default through
`electron/src/tts-config.mjs`. Runs opt into script/audio with two
editor checkboxes (default off); the main process resolves the
effective triple plus the verified vault TTS key, passes
`--generate-tts --tts-model/--tts-voice/--tts-voice-direction`
(worker re-validates and fails fast), and injects
`AI_COMMENTATOR_PROVIDER_API_KEY` only for TTS runs. Credential
deletion now also guards project TTS overrides and the global TTS
default. See `docs/contracts/tts-studio-v1.md`. `tts-v1` and
`script-v1` are unchanged.

Verification: Python suite 447 tests OK (new `test_tts_catalog.py`,
worker `--tts-*` cases; offline, fakes only); Electron suite 206
tests pass, 0 fail (offline, `node:test`); renderer production build
and full `electron-forge package` succeed. No live Gemini calls were made; renderer
behavior beyond the static hook-import guard is covered by manual
steps (catalogue load, save/reset round-trips, preview playback,
opt-in run wiring) in the task handoff.

## Script-to-audio generation pipeline (M6, on `feature/tts-generation`, uncommitted)

`run_generate_tts` (`python/ai_commentator/tts/runner.py`) reads the
validated `script-v1` artifact (never modifies it), synthesizes each
segment sequentially with the shared `GeminiTTSClient` (pinned model,
voice `Kore`, unchanged voice direction), and writes
`output/audio/segments/<segment-id>.wav` plus the versioned `tts-v1`
manifest (`output/audio/tts.json`, see
`docs/contracts/tts-v1.md`). Manifest validation lives in
`python/ai_commentator/tts/manifest.py`; WAV bytes use the new atomic
`write_bytes_atomic` storage helper.

Failure handling is per segment: failures are recorded with redacted
diagnostics, successes are preserved, and the run exits non-zero
unless every entry succeeded (or the script was silent). Malformed
scripts, `error`-status scripts, and filename collisions fail before
any paid call; reruns re-synthesize everything (explicit policy, no
resume). The TTS key arrives only via
`AI_COMMENTATOR_PROVIDER_API_KEY`; Electron does not yet inject a
vault TTS credential, so Electron-spawned runs cannot reach the stage
until project TTS settings exist.

Triggers: worker `--generate-tts` stage (requires `--with-script`,
runs after script generation, fails fast without the TTS key) and
`python/main.py --generate-tts` CLI mode over an existing script.
`tts_say.py` is unchanged and still works. No Electron changes; no
playback, mixing, retry, or concurrency work.

Verification: new `tests/test_tts.py` (19 tests) plus 7 new
`tests/test_worker.py` cases (flag validation, TTS key fail-fast,
mocked `tts` stage success/failure), all offline with mocked
synthesis. No live Gemini calls were made.

## Gemini TTS API configuration (credential setup milestone)

The API Keys page includes a distinct Google Gemini TTS provider. TTS
credentials use the existing Electron `safeStorage` vault and atomic
ciphertext writes, with a `tts` purpose and no model field; they cannot be
selected for project Vision processing. The renderer receives only sanitized
credential metadata. Key replacement resets its verification state, and
project reference protection continues to apply to deletion.

TTS connection verification runs as a separate Python setup operation using
the official `google-genai` SDK. It requests metadata for the fixed current
Gemini 3.8 Flash TTS model with a 10-second SDK timeout and performs no speech
generation. A success confirms API authentication and access to that model's
metadata only; it cannot establish inference entitlement without generating
speech. A failed recheck of the unchanged credential clears its prior verified
status so the list cannot present an old success as current. No live Google
requests were made during implementation tests.

## Provider vault, multi-provider vision & configuration studio (M6, on current branch, uncommitted)

Two curated providers (`meta` via Responses API `/responses`, `baseten`
via OpenAI-compatible Chat Completions with the pinned
`meta-models/muse-spark-open`) sit behind an explicit adapter
boundary under `python/ai_commentator/vision/providers/` (registry +
curated catalogue, no discovery, no arbitrary URLs). Batch, adaptive,
writer, and script stages resolve the adapter from the explicit
`AI_COMMENTATOR_PROVIDER/MODEL/API_KEY` environment with a
Baseten-typed legacy fallback; observation validation, sampling,
evidence gating, and the NDJSON/stop protocols are unchanged.
Mocked tests cover both adapters (request shapes, extraction, error
mapping, secret redaction, catalogue validation). No live paid
provider verification was performed; the exact Meta `input_image`
member shape is isolated behind the Meta adapter (see ADR 0008).

Electron owns a multi-credential vault (`provider-vault.json` +
`credentials/<id>.enc`, safeStorage, atomic writes, no plaintext
fallback), a Free Fire game library with immutable built-ins, and
per-project configuration references (`project.json` `configuration`).
The renderer has a grouped sidebar (Workspace / Configuration), an
API Keys management page (add, rename, replace key, change model,
test connection, verify image support, delete with project-reference
guard), a Games & Prompts page (profiles, presets, preview, immutable
built-ins), a Preferences page, and an editor Configure tab with the
three selectors plus manage-links that preserve the open project.
Paid runs resolve only the selected credential and require image
verification; nothing silently falls back. Legacy M5 installs migrate
once (credential, game/preset records, key archive) or report a
reconfiguration notice.

Verification: Python suite 396 tests OK (offline, fakes only);
Electron suite 152 tests pass, 0 fail (offline, `node:test`);
renderer production build (`vite build` with
`vite.renderer.config.mjs`) succeeds. Provider setup checks and
image verification have not been live-tested; verification requests
may incur provider charges. Windows SIGTERM fallback remains
unexercised.


## Adaptive sampling workspace (M4.2-A/B, on `feature/adaptive-sampling-engine`, uncommitted)

Electron can stop a live adaptive Python worker through a versioned
stdin control line (`{"type":"stop","version":1}`), routed to the
existing adaptive `StopToken` without blocking the loop; the in-flight
request completes, validates, and persists before the worker emits
terminal `stopped` (exit `0`). The workspace offers Adaptive Sampling
as an explicit paid mode (key-gated, never the default) with a visible
"Maximum vision requests" bound (UI default 10; the engine default 60
and hard cap 10000 are untouched). Each persisted iteration emits a
validated `adaptive_sample` message that the renderer folds into run
state and shows as a chronological sampling activity (timestamp, speed,
reason, next schedule); cooperative Stop shows an honest stopping state
that settles only on the terminal message, with `stopped` distinct from
`done`/`error`/`cancelled`. Fractional adaptive observations
(`frame_00000.5.json`) and `adaptive_run.json` are listed and readable
in the artifact browser (new Manifest tab with decision history).

Verification: Python suite 357 tests OK (offline, fakes only);
Electron suite 99 tests pass, 0 fail (offline, `node:test`); renderer
production build (`vite build`) succeeds. Adaptive failures now carry
the recorded validation reason in the terminal error message, and the
run panel shows the recent worker log under failed runs. No paid API
calls were made.
The Kokonut UI component is untouched. Windows SIGTERM delivery for
the forceful-cancel fallback was not exercised (stdin stop is
signal-free and covered).

## Commentary Studio UI foundation

The renderer's existing Settings navigation now contains provider, game, and
commentary setup backed by a single global `settings.json` in Electron
`userData`. Settings are validated and atomically replaced; API credentials
are stored separately as Electron `safeStorage` ciphertext. The renderer only
receives key-presence and secure-storage-availability booleans. First launch
routes to Settings until setup is marked complete; optional setup can be
skipped, and the same page remains available from navigation.

The first provider is OpenAI-compatible, defaulting to the existing Baseten
URL and Muse model ID. A separate Python setup command tests the connection,
lists models (all explicitly marked unverified), and verifies image input
with an explicit small-image request. Only selected models manually verified
for image input are accepted for paid runs using the stored key. Provider
configuration and bounded game/prompt preferences are passed to the Python
worker through its child environment; the existing stdin stop protocol is
unchanged. Style preferences are appended only to gated commentary/script
prompts; the validated observation schema and deterministic claim/script
validators remain authoritative.

The provider setup check and model list have not been live-tested. The
explicit image-capability check is user-triggered and may incur provider
charges; test suites use fakes only. OS-backed secure storage is required for
saved keys; there is no plaintext fallback. The legacy `BASETEN_API_KEY`
process environment remains a compatibility path.

The Electron renderer opens into a 900 × 650 windowed studio shell with a
toggleable navigation sidebar and live worker-status header. An open project
uses a bounded editor with independently toggleable processing/project
inspector, central Preview and Artifacts tabs, and a docked tabbed bottom
workspace. Audio is the only implemented bottom panel and shows honest empty
playback lanes at a fixed height. Processing actions/status and source details
remain project-scoped; artifact browsing stays project-scoped. Project source
preview uses the main-process `project://` protocol under both development
and packaged origins; it only serves the source filename recorded in project
metadata. The preview keeps native video controls and contains the source in a
dark, constrained stage. It reports available playback time, duration, source
dimensions, and playback status, with separate empty, loading, and playback
error states. Seeking beyond buffered video content can still fail; that media
protocol limitation remains unresolved. Prompt inspection and standalone audio
playback remain placeholders. The right inspector separates Processing,
Configure, and Project information into fixed-header tabs with independently
scrolling content; processing details remain driven by the worker view state.
The UI palette is monochromatic with semantic status accents. Window size and
lifecycle are unchanged. No Python engine or worker protocol behavior changed.

## M5 Configuration & Setup

The renderer's existing Settings navigation now contains provider, game, and
commentary setup backed by a single global `settings.json` in Electron
`userData`. Settings are validated and atomically replaced; API credentials
are stored separately as Electron `safeStorage` ciphertext. The renderer only
receives key-presence and secure-storage-availability booleans. First launch
routes to Settings until setup is marked complete; optional setup can be
skipped, and the same page remains available from navigation.

The first provider is OpenAI-compatible, defaulting to the existing Baseten
URL and Muse model ID. A separate Python setup command tests the connection,
lists models (all explicitly marked unverified), and verifies image input
with an explicit small-image request. Only selected models manually verified
for image input are accepted for paid runs using the stored key. Provider
configuration and bounded game/prompt preferences are passed to the Python
worker through its child environment; the existing stdin stop protocol is
unchanged. Style preferences guide model-worded commentary/script paths;
schema validation and deterministic evidence/script validation remain
authoritative.

Python suite: 361 tests passed offline. The full Electron suite passed 104
tests before the final schema-hardening/test additions; the latest focused
settings and processing suites passed 18/18. A later full-suite rerun was
interrupted. Renderer production build passed. Provider setup checks have not
been live-tested. The explicit image-capability check is user-triggered and
may incur provider charges. Secure-storage unavailability has no plaintext
fallback. The legacy `BASETEN_API_KEY` process environment remains supported.

## Modularization status

Project storage is implemented under `electron/src/project-store/`: `metadata.mjs`
owns project lifecycle and metadata persistence, `artifacts.mjs` owns bounded
artifact discovery and JSON reads, and `media.mjs` owns the validated
project-media path resolver. `electron/src/project-store.mjs` and
`project-store/index.mjs` preserve the existing import surface.

The Python engine is organized under `python/ai_commentator/`: `config.py`,
`errors.py`, and `storage.py` provide shared foundations; `vision/` owns frame
handling, image/provider requests, observation validation, migration, and
batch execution; `state/match_state.py` owns state validation and
reconstruction, with `state/runner.py` rebuilding snapshots;
`events/detection.py` owns event rules and `events/runner.py` executes them;
`commentary/` owns claim validation/gating, writer wording, and generation;
`script/generation.py` owns script validation and `script/runner.py` executes
generation; and `cli.py` dispatches existing CLI
modes. `python/main.py` is the compatibility facade for tests and existing
imports. `python/worker.py` continues to import it as `main` and retains the
same NDJSON orchestration.

Electron `src/main.js` is now the composition point for app lifecycle and
dependency wiring. Window creation, the project media protocol, processing
IPC, and project/artifact IPC live in `src/main/window.js`,
`src/main/media-protocol.js`, and `src/main/ipc/`. The renderer remains divided
into app sections, layout, hooks, components, primitives, and libraries;
`WorkspaceSection` and `ArtifactBrowser` remain the largest feature components.
No documented data contract or pipeline behavior was intentionally changed.

Modularization verification: `.venv/Scripts/python.exe -m unittest discover
-s tests -v` passed 261 tests; `npm test` in `electron/` passed 52 tests;
Python CLI help, Electron main-module syntax checks, and an offline worker run
(12 valid NDJSON messages, exit 0) passed. `npm run package` built the main,
preload, and renderer Vite bundles, but Forge packaging could not finish
because its download request was blocked by the environment (`connect EACCES`).
No paid API calls were made.

Factual snapshot of the project as inspected in the repository.
Nothing here is a claim about future work; for the plan, see
[architecture.md](architecture.md) and [roadmap.md](roadmap.md).

Verification note: the engine lived in root `main.py` and ran under
Docker until the Electron/native migration (see
[decisions/0002-native-electron-python.md](decisions/0002-native-electron-python.md)).
Milestone 2–5 and 8b results below were verified before the migration
(241 unit tests passing on the host venv; Docker runs where noted). The
migration preserved the engine unchanged apart from path handling and
CLI wiring (verified by the suite passing after the move, plus 13 new
worker tests and 15 new Electron tests). No Baseten calls were made
during the migration.

## Existing files and responsibilities

- `python/main.py` — compatibility facade for the engine's public functions
  and the existing CLI. Domain implementations live under
  `python/ai_commentator/`; `python/worker.py` continues to import the facade.
  The seven CLI modes preserve the existing behavior:
  - Default (`python python/main.py [--video PATH] [--output-dir DIR]`):
    extracts frames from the selected video (default
    `gameplay/match.mp4`) every 3 seconds (`INTERVAL = 3`) into
    `output/frames/` as `frame_<timestamp>.jpg`, printing FPS, frame
    count, and duration. Never writes JSON or migrates anything. All
    default paths resolve from the repository root regardless of working
    directory; `--video`/`--output-dir` override them.
  - Vision test (`--vision-test`): validates
    `output/frames/frame_00000.jpg` (non-empty, decodable image, image MIME
    type), requests an `observation-v1` JSON observation
    (see `docs/contracts/observation-v1.md`), strictly parses and validates
    it (`parse_observation` / `validate_observation`), prints the validated
    JSON, and saves it to `output/observations/frame_00000.json`
    (git-ignored). Invalid model output exits non-zero and saves nothing.
    API key is read from the `BASETEN_API_KEY` environment variable and
    redacted from error output. Server-side schema enforcement is
    unavailable for this model, so validation happens in code.
  - Vision batch (`--vision-batch [--limit N] [--force] [--jobs J]`):
    discovers existing `frame_<timestamp>.jpg` files (numeric-timestamp
    order), selects up to N spread across the clip (default 5, endpoints
    included; limit 1 selects the first frame), and runs each selected
    frame through the same shared vision pipeline as `--vision-test`
    (`analyze_frame`, via the `process_batch_frame` worker). Each success
    writes one validated `observation-v1` JSON into `output/observations/`
    via atomic temp-file replace; model timestamps must match the source
    frame or the response is rejected. Frames with an already-validated
    observation in the observations directory are skipped unless `--force`
    is given. `--jobs` (default 1, max 4) bounds how many vision requests
    run concurrently via `ThreadPoolExecutor`; reporting is reassembled in
    selected-frame order, never completion order. A live client is never
    shared across threads — each frame gets a fresh `OpenAI` client
    (installed SDK 3.40.0 states no thread-safety guarantee, so the design
    does not depend on one; construction performs no I/O). Each internally
    created client is closed after its request finishes, success or failure
    (context-managed factory); caller-injected clients are never closed.
    Per-frame
    failures, including unexpected client errors such as timeouts (real
    `APITimeoutError`s surface as `VisionAPIError` through the existing
    `APIError` mapping), are reported and the run continues; the final
    summary prints available/selected/succeeded/failed/skipped counts and
    the process exits non-zero unless every selected frame has a validated
    observation. No retries or combined output file. Legacy JSONs beside
    the frames only trigger a warning pointing at `--migrate-observations`.
    Extraction interval is unchanged (`INTERVAL = 3`); no sampling stride
    or intensity classifier was added.
  - Migration (`--migrate-observations`, offline): moves
    validated legacy `output/frames/frame_*.json` files to
    `output/observations/` with byte-copy + destination verification
    before source removal; byte-identical duplicates are removed, while
    conflicting destinations and invalid files are left in place and
    reported. Idempotent; exit 0 only when no legacy files remain.
  - State rebuild (`--rebuild-state`, offline, no Baseten
    calls): validates each `output/observations/frame_*.json` (schema plus
    filename timestamp), folds them into a `match-state-v1` document
    (`apply_observation` + `finalize_match_state`), validates the built
    state, and atomically writes `output/observations/match_state.json`.
    Exit 0 only when at least one observation was accepted and none was
    rejected. See `docs/contracts/match-state-v1.md`.
  - Event detection (`--detect-events`, offline, no Baseten
    calls): refuses to run on a stale snapshot (state timestamps and
    content hashes must exactly cover the discovered observations), then
    evaluates two conservative rules — `kill_feed_entry` (transcribed
    names in a mentioned feed) and `elim_count_increased` (same-team
    counter strictly increasing) — and atomically writes
    `output/events/events.json` (`validate_events`, `detect_events`).
    Everything fires as `candidate` with quoted evidence, source frame
    timestamps, and state fact ids; missing nameplates, ambiguous HUD
    numbers, timers, persistent banners, low-confidence triggers, and
    contested evidence are suppressed, never resolved. Exit 0 only when
    at least one observation was accepted and none was rejected. See
    `docs/contracts/events-v1.md`.
  - Commentary generation (`--generate-commentary`,
    offline, no Baseten calls): validates observations, `match_state.json`
    (timestamps + content hashes must cover inputs), and `events.json`
    (its `generated_from` must cover inputs), then gates claims
    deterministically (`gate_commentary_claims`: current facts only,
    confidence floor, uncertainty/conflict/category scope, candidate
    events with clean sources) and renders them with fixed templates only
    (`render_commentary_claims`: verbatim descriptions plus a hardcoded
    qualifier for `event_echo`; no confirmation path exists). Repeat runs
    suppress unchanged claims against the previous commentary file
    (missing = first run; malformed = warning + first run; emitted history
    spans prior lines and prior `already-emitted` records so silence
    converges). Validates the document with provenance
    (`validate_commentary` + bundle: refs resolve, evidence contained in
    text and sources, name-token closure, confidence ceiling, template
    preconditions) and atomically writes
    `output/commentary/commentary.json`. Exit 0 on valid inputs even with
    zero lines (deliberate silence); exit 1 on invalid inputs or write
    failure with the previous file intact. See
    `docs/contracts/commentary-v1.md`.
  - Writer mode (`--commentary-write`, paid opt-in): runs
    the same validate → gate → suppress pipeline, then words up to 6
    prioritized claims (developments/echoes first) with one text-only
    model call over gated claims plus the last 4 spoken lines — never raw
    observations or full history. Every model line is re-validated
    (evidence containment, token closure, verbatim qualifier) with
    per-line template fallback; provider/parse failure falls back to the
    full deterministic run with a warning, never a crash. Fresh client
    per run (closed after); injected clients never closed; missing key
    raises before any call. Silence makes no call. Same output contract,
    same exit codes; `template` names the gating template in both modes.
  - Script mode (`--generate-script`, paid opt-in): runs
    the same validate → gate pipeline plus repeat suppression against the
    prior script and recent commentary history, then words at most 6
    prioritized claims with one bounded text-only Muse Spark call (same
    endpoint/model, never frames or full history). Segments carry natural
    caster paraphrase validated deterministically (`script_text_valid`:
    TTS shape, name/number closure, forbidden kill/outcome/action/zone/
    causal/intent sets, echo uncertainty without certainty language) —
    no verbatim-quote requirement and no template fallback. Timestamps
    are derived from cited evidence, never invented. Provider, parse, or
    validation failure writes an explicit `error` status (exit 1), never
    a false success; zero eligible claims writes `silence` with no model
    call (exit 0). Atomically writes `output/script/script.json`
    (`script-v1`, see `docs/contracts/script-v1.md`); upstream
    observation, state, event, and commentary files are only read, never
    rewritten. Missing key fails fast before any call, writing nothing.
- `python/worker.py` — the Electron worker. Parses a video path plus
  `--output-dir`/`--limit`/`--force`/`--jobs`/`--skip-vision`/`--with-script`,
  reuses the engine runners above (never duplicates pipeline logic), and
  reports NDJSON on stdout (`started`, `progress`, `stage_completed`,
  `result`, `error`; see `docs/contracts/worker-protocol.md`). Engine
  prints are redirected to stderr; secrets never printed; exit 0 on
  success, 1 on stage failure, 2 on validation errors. Testable without
  Electron and without paid calls (`--skip-vision`, no key needed).
- `electron/` — the desktop shell: `src/main.js` (app composition and lifecycle),
  `src/main/window.js` (window setup),
  `src/main/ipc/processing.js` (worker lifecycle and selection IPC),
  `src/main/ipc/projects.js` (project/artifact IPC),
  `src/main/media-protocol.js` (project media scheme),
  `src/preload.js` (audited `contextBridge`: `processVideo`,
  `cancelProcessing`, `onWorkerEvent`), `src/worker-protocol.mjs`
  (incremental NDJSON parser, input validation, `.venv`/worker
  resolution), `src/python-worker.mjs` (spawn manager with cancel and
  cleanup), `src/renderer.jsx` + `src/components/` (React entry, minimal
  worker-status view), `test/` (`node:test` suites, no dependencies).
- `requirements.txt` — `opencv-python-headless`, `openai` (root, unchanged).
- `.env.example` — documents `BASETEN_API_KEY` with no values.
  A local `.env` holds the real key (git-ignored).
- `.gitignore` — excludes `.env`, `.venv/`, caches, `gameplay/`, `output/`,
  Electron `out/` and `.vite/`, `.vscode/`.
- `README.md` — native setup, engine commands, worker usage, Electron
  development commands, testing; details live in `docs/`.

## How to build and run (native)

See [testing.md](testing.md) for the exact commands. In short:

```sh
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
.venv/bin/python python/main.py                          # extract frames
.venv/bin/python python/main.py --vision-test            # one paid request
.venv/bin/python python/main.py --vision-batch --limit 5 # paid, opt-in
.venv/bin/python python/worker.py gameplay/match.mp4 --output-dir /tmp/run --skip-vision  # offline
cd electron && npm install && npm test && npm run package && npm start
```

## Output directory layout

- `output/frames/` — extracted JPEGs only (`frame_<timestamp>.jpg`).
- `output/observations/` — generated JSON only: `frame_<timestamp>.json`
  per analysed frame plus the rolling snapshot `match_state.json`.
- `output/events/` — generated event output only (`events.json`).
- `output/commentary/` — generated commentary only (`commentary.json`).
- `output/script/` — generated final casting script only (`script.json`,
  the TTS input contract; TTS itself is not implemented).
- Everything under `output/` is git-ignored. `--output-dir` re-bases the
  whole tree; defaults resolve from the repository root.

## Required environment variables (names only, no values)

- `BASETEN_API_KEY` — required for paid stages; empty otherwise.

A `.env` file is present in the working tree (git-ignored) and the host
environment defines `BASETEN_API_KEY`. Secret values are never recorded here.

## Actual model configuration

- Base URL: `https://inference.baseten.co/v1` (`BASETEN_BASE_URL`).
- Model identifier: `meta-models/muse-spark-open` (`BASETEN_MODEL`).
- Do not change the model ID outside an explicit application task.

## Electron/Python integration status

- Worker protocol defined ([contracts/worker-protocol.md](contracts/worker-protocol.md));
  `python/worker.py` verified independently (offline run: NDJSON-only
  stdout ending in `result`, exit 0; validation/key failures emit `error`
  with exit 2/1; no secrets on either stream).
- Electron main launches the worker via `spawn()`, parses stdout
  incrementally, forwards progress/results to the renderer, refuses a
  second concurrent job, supports cancel, and terminates the child on
  app exit. Verified by `node:test` suites and by driving the real worker
  from Node (offline, no paid calls); the earlier native migration's
  package run built cleanly. The latest modularization package attempt
  built all Vite targets but was blocked during Forge's network download;
  see the modularization verification note above.
- Production interpreter packaging is explicitly out of scope: the
  integration target is local development with a native `.venv`.

## Latest verified test results

- Pre-migration baseline (root `main.py`, host venv,
  `python -m unittest discover -s tests`): **241 tests, all passed**.
- Post-migration: **254 Python tests, all passed**
  (`.venv/bin/python -m unittest discover -s tests`: the 241 migrated
  engine tests plus 13 new `tests/test_worker.py` protocol tests) and
  **15 Electron tests, all passed** (`npm test` in `electron/`);
  the one migration-caused failure (a CLI test that relied on
  cwd-relative paths) was fixed by passing `--output-dir` at the call
  site, which also covers the new flag. `npm run package` builds
  cleanly; the worker was driven from Node end-to-end (offline,
  exit 0, no paid calls).
- Historical detail (pre-migration runs, kept as evidence for the engine
  behavior the migration preserved):
  - Synthetic concurrency benchmark (`tests/benchmark_jobs.py`, fake
    sleeping client, zero network): 5 uncached mocked requests complete in
    **1.51s with `--jobs 1` vs 0.61s with `--jobs 4`**, with byte-identical
    outputs. These numbers measure lock-step fake sleeps, not model latency,
    and are not a production speedup claim.
  - Commentary generation on the real tree: **passed** — first run 5
    discovered, 5 accepted, 0 skipped, 0 rejected, **9 lines** (all
    `development` at 195s), 41 suppressed, exit 0; second run 0 lines, 50
    suppressed (deliberate silence), exit 0; third and fourth runs
    byte-identical to the second (convergence verified by hash).
  - Event detection on the real tree: **passed** — 5 discovered, 5 accepted,
    0 skipped, 0 rejected, **0 emitted**, 0 contested, exit 0. A rerun is
    byte-identical. Zero events is the honest result: the kill feed is
    mentioned but never transcribed, and no team-scoped elim counter
    repeats across frames.
  - State rebuild on the real tree: **passed** — 5 discovered, 5 accepted,
    0 skipped, 0 rejected, 0 conflicts, exit 0 (39 facts, 39 changes,
    30 uncertainties, latest 195; 28 stale / 11 current). A second rebuild
    is byte-identical.
  - Offline batch check post-migration: `--vision-batch --limit 1` skipped
    frame 0 from the new observations directory, exit 0, no key, no network.
  - Live single-frame vision test (milestone 2, prior session): **passed** —
    HTTP 200, model returned pure JSON conforming to `observation-v1`.
  - Live multi-frame observations (milestone 3 evidence, authorized run by
    the user before this session): 5 stored JSONs (timestamps 0, 48, 96,
    147, 195) all validate against `observation-v1`.
  - Frame extraction logic unchanged apart from path handling (verified via
    `git diff`) and covered by the offline synthetic-MP4 test.
- No Baseten calls were made in the migration session.

## Not implemented yet

TTS/audio playback, live capture, OBS integration,
Free Fire knowledge pack, and dashboard artifact browsing.
(Stage 1 video selection + run wiring is implemented, see below. Multi-frame
runs, output separation, match-state tracking, conservative event
detection, bounded batch concurrency, evidence-grounded commentary, the
LLM writer path, the final LLM casting script, the Electron worker
protocol, and the spawn/IPC integration are implemented. The writer and
script paths are verified on fixtures with fakes only; no live writer or
script call has been made. The production Python-packaging story is out
of scope. Cosmetic note: worker-thread
progress lines may interleave on stderr under `--jobs 2+`; the saved-file
record and final summary always print deterministically from the main
thread.)

## Renderer UI foundation (Stage 0, on `feature/ui-setup`, uncommitted)

- Obsidian AI design system documented in `docs/ui/` (identity, tokens,
  architecture, component/motion guidelines, roadmap).
- Renderer stack: React 19 + Vite 5 + Tailwind v4 (CSS-first `@theme`
  tokens in `electron/src/index.css`), shadcn manual setup
  (`components.json`, `tsx: false`, `@/` alias via renderer Vite config
  + `jsconfig.json`; generated `button`, `card`, `badge`, `separator`,
  `skeleton`), `motion` (via `motion/react`), `lucide-react`,
  `@fontsource` Inter + Geist Mono.
- App shell: `AppLayout` + `Sidebar` (Dashboard/Matches/Commentary/
  Settings, active `layoutId` indicator), `PageHeader`, `GlassPanel` /
  `GlassCard` / `StatusIndicator` primitives, honest empty dashboard +
  stubs; `WorkerStatus` bridge logic unchanged (restyled).
- Verified: `npm test` 15/15; renderer `vite build` clean with token
  utilities present; dev app boots with renderer connected and no app
  console errors. Forbidden areas untouched (Python, worker protocol,
  main/preload, security settings, model ID).

## Stage 1 — video import and processing (on `feature/video-import-processing`, uncommitted)

- Approved exception to the renderer-only rule: `select-video` IPC
  (`dialog.showOpenDialog` + `ipcMain.handle` in `main.js`, `selectVideo`
  in `preload.js`). Read-only native dialog, main-side validation,
  `sizeBytes` via `fs.statSync`; no filesystem access reaches the
  renderer. `nodeIntegration`/`contextIsolation` unchanged.
- `VideoImport` (selection, `file://` preview with honest fallback,
  metadata) + `RunPanel` (stage-level progress, skipped-stage honesty,
  cancel, result summary from real `result` fields, human-readable
  errors) in the Dashboard; `WorkerStatus` preserved.
- Pure `lib/worker-view.js` mapper (settled-gating so a new run starts
  only after the previous worker exits) + `lib/format.js` helpers, both
  covered by `electron/test/worker-view.test.mjs`.
- Default run is offline-safe: `processVideo(path, { skipVision: true })`,
  no API key needed, no paid calls. `withScript` never enabled by default.
- Docs synced: `UI_ARCHITECTURE.md` (current structure, 4-function
  bridge), `COMPONENT_GUIDELINES.md` (`PageHeader` under `layout/`),
  `AGENTS.md` bridge lists, `UI_ROADMAP.md` Stage 1 acceptance.

## Stage 1.5 step 1 — Obsidian Studio overhaul (uncommitted)

- Near-black token system (`studio-950` `#030304` → `studio-800`
  `#121218`, solid `#1C1C24` hairlines, `#9670FF` accent); glass
  demoted to overlays only; 13px UI body, 15px section titles.
- Flat shell: `AppLayout` (sidebar + `AppHeader` bar + content),
  restyled `Sidebar`, shared `hooks/useWorkerStatus` (header pill +
  `WorkerStatus` card); removed unused `GlassPanel`/`PageHeader`;
  opacity-only section transitions.
- Dashboard recomposed (import → worker → marked-planned Projects
  area); control-state/a11y pass (labels, live regions, focus rings).
- Verified: Electron suite, renderer build, dev boot (see task report).

## Stage 1.5 — project-first dashboard + workspace (on `feature/video-import-processing`, uncommitted)

- Approved project IPC in `main.js`/`preload.js` (`list-projects`,
  `create-project`, `open-project`, `update-project`, `delete-project`)
  plus `projectId`-bound `process-video` (main resolves source + output
  from stored metadata). New `electron/src/project-store.mjs` (userData
  storage, allow-listed ids, containment checks, atomic writes,
  stage-then-rename creation) covered by
  `electron/test/project-store.test.mjs` (6 tests).
- Dashboard is project-first ("Your Projects" + Add Project flow with
  naming step; rows with status; honest empty state; two-step delete).
  New `WorkspaceSection` (preview + native playback, audio-lane
  placeholders, project-bound processing via reused `RunPanel`,
  per-project status persistence). `VideoImport` removed.
- Verified: 34/34 Electron tests, 254/254 Python tests, renderer build
  clean, dev boot with no app console errors, real offline run through
  the mapper; per-project output isolation confirmed.

## Hardening + artifact browsing (on `feature/video-import-processing`, uncommitted)

- Worker stage planning (`plan_stages` pure of flags + observation
  presence): fresh + `--skip-vision` completes as `extraction-only`
  (exit 0, honest counts, null artifacts); corrupt observations still
  fail `state_rebuild`. `completed` excludes skipped; totals equal the
  plan. Contract updated (additive: `skipped`, `mode`, skip reasons).
- `interrupted` recovery: store backstop (`settleProjectRun`,
  `reconcileInterruptedRuns`), startup reconcile, main exit tracking
  with quit-awareness; renderer surfaces the notice and re-runs.
- Artifact browser in the workspace (Tabs: frames with `project://`
  thumbnails, observations, match state, events, commentary) over
  `list-artifacts` / `read-artifact` plus the privileged `project://`
  media scheme (validated scopes/names/types, bare 404s).
- Verified: 256/256 Python, 41/41 Electron (see task report).

## Vision-enabled processing (Milestone 7, on
`feature/video-import-processing`, uncommitted)

- Workspace processing-mode selector: AI analysis (up to 10 frames,
  default when a key is configured) vs offline extraction.
- Explicit `--limit 10` via `buildWorkerArgv`; main-process key gate
  before spawn plus `vision-status` IPC (boolean only); `limit`
  validated before spawn, engine validates again.
- RunPanel shows real stage detail counts and skip reasons; full runs
  are labelled AI analysis, extraction-only runs keep their notice.
  ArtifactBrowser already refetches on run-status change.
- Verified: 261/261 Python (incl. 5 new vision-mode tests),
  52/52 Electron (incl. 11 new), renderer build clean. Real
  `--limit 10` run on `gameplay/match.mp4`: 66 frames, 10/10
  observations, state rebuilt, 0 events (honest), 8 commentary lines.

## Adaptive sampling engine (M4.1, on `feature/adaptive-sampling-engine`, uncommitted)

- Sequential LLM-guided loop replacing fixed extraction for the adaptive
  path: `ScheduledVideoReader` (one open `VideoCapture`, on-demand
  scheduled captures, always released) → one real Baseten vision request
  carrying at most the previous validated observation → strict wrapper
  validation (`observation-v1` half plus separate HIGH/NORMAL/LOW
  sampling half) → atomic observation write → scheduler maps the label
  to the next timestamp (HIGH 0.5s, NORMAL 3.0s, LOW 6.0s; first sample
  at 0; terminates at video end or `max_frames`). No retries, no repair
  calls, one finite SDK timeout, at most one paid request per frame.
- Invalid sampling falls back to NORMAL with diagnostics and never
  discards a valid observation; malformed/observation-invalid responses
  fail the run without writing. Adaptive metadata (speeds, bounded
  reasons, run status) lives only in `output/observations/adaptive_run.json`
  (`adaptive-run-v1`); `observation-v1` is unchanged. Fractional stamps
  use `frame_00000.5.json` (parsed as float); integer names are untouched.
- Cooperative stop: `StopToken` checked before each capture, before each
  paid request, and after each persisted observation. An in-flight
  request always completes and persists; the run then ends `stopped`.
  The worker maps SIGTERM to the token in adaptive mode only and emits a
  `stopped` terminal message (exit 0); other modes are unchanged.
  Electron parses/forwards `stopped` with no new controls, so a
  cancel-initiated graceful stop still settles the UI as `cancelled`.
- CLI: `python/main.py --adaptive [--adaptive-max-frames N]`
  (`--video` allowed); worker: `--adaptive [--adaptive-max-frames N]`
  with `adaptive_vision` stage, `adaptive` run mode, conflict rejections
  (exit 2), and unchanged downstream stages. Batch extraction, batch
  vision, state, events, commentary, and script behavior are preserved.
- Verified: 323/323 Python tests (261 pre-existing plus 62 new adaptive
  tests covering scheduler, validation, reader, orchestration, all six
  stop stages, worker protocol, and CLI); Electron suites pass except
  pre-existing sandbox temp-dir permission failures unrelated to this
  change (see task report). Real API check: 2 paid requests total (one
  CLI, one worker end-to-end on a 4 s synthetic probe) — HTTP 200,
  wrapper validated, observation persisted, LOW decision correctly ended
  the run at video end, manifest complete, no secrets in any stream.
- Limitations: OpenCV timestamp seeks are backend-dependent (observation
  timestamps name the scheduled time, not a frame-perfect decode claim);
  Windows cancel still terminates immediately (no graceful SIGTERM);
  failure terminates the run (no skip-and-continue yet); no UI trigger
  for adaptive runs or dedicated stop control exists yet.

## Recommended next milestone

Roadmap milestone 9 (TTS and audio playback), then adaptive
sampling follow-ups (M4.2: UI-triggered adaptive runs, bounded skip-and-continue, dedicated stop control).
See [roadmap.md](roadmap.md).
