# Golden fixture: real Clash Squad run 1

Real-model observation set for offline replay and eval. No pipeline
behavior changes; replay tools read these files without any network
or model calls.

- game: Free Fire Clash Squad
- duration: 63.27s (`adaptive_run.json`: 63.2667s, video-end)
- resolution: 1280x576
- prompt pack: free-fire
- source: real run (`friday-finals` project, adaptive sampling)
- files: 30 `frame_*.json` observations + `adaptive_run.json` manifest
- schema: `observation-v2` throughout; 122 entries total
- category mix: environment 30 / other 16 / combat 43 / character 33
- sampling speeds: HIGH 8 / NORMAL 19 / LOW 3

## Known defects

- D1: 29 negation entries ("No ...", "no clearly visible") are filed
  as positive observations (28 combat, 1 other). Absence is worded as
  presence, and substring signal matching reads the named-but-absent
  vocabulary (muzzle, grenade, smoke, vehicle).
- D2: `observation-v2` structured keys are never populated: 0 of 122
  entries carry `subjects`, `action`, or `spatial`, so entity tracks
  and engagement timelines have no structured seeds on this run.
- D3: the `hud` category is never observed (0 of 122 entries), so no
  kill-feed, Elim-counter, or timer readings exist and the
  feed/counter/streak rules cannot fire on this run.

(Defect IDs D1-D3 were not defined in the task brief; the entries
above describe properties observed in the fixture itself. Counts are
also printed by `python/tools/replay_legacy.py`.)
