"""Offline replay of a legacy adaptive run, up to but excluding model calls.

Usage:
    python -I python/tools/replay_legacy.py <observations_dir> [--out DIR]

Reads ``adaptive_run.json`` plus the referenced ``frame_*.json`` files,
validates every observation with :func:`validate_observation`, then
mirrors the :class:`StreamingPipeline` window logic (a window triggers
once ``WINDOW_MIN_OBSERVATIONS`` observations are pending or an
iteration arrives at ``HIGH`` speed, plus a final flush). Each window
rebuilds match state and events over the whole prefix seen so far and
runs the deterministic stages only::

    build_match_state -> detect_events -> gate_commentary_claims
    -> prioritize_writer_claims -> build_gameplay_state
    -> build_narrative / render_narrative_block -> build_script_prompt

No model call is made: no writer request, no parsing of model output,
no TTS. History stays empty (there is no wording offline), so the
narrative "spoken" section is always empty. Spoken history from a live
run is not replayed.

Per window the tool writes ``prompt_window_NN.txt`` (the exact prompt
that would have been sent) into ``--out`` (default ``./replay_out``)
and prints events, fresh claims, suppression counts, and the narrative
block. It also prints schema-usage stats over all validated
observations.

Fully offline: stdlib plus the engine's pure functions. No network, no
API key, safe under ``python -I``.
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

# Mirror tests/: the engine lives in <repo>/python, which is not an
# installed package, so put it on sys.path from this file's location.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main as engine  # noqa: E402


def is_negation_entry(description: str) -> bool:
    """Whether an entry description states absence rather than presence."""
    stripped = (description or "").strip()
    return (
        stripped.startswith("No ")
        or stripped.startswith("No,")
        or "no clearly visible" in stripped.lower()
    )


def load_iterations(observations_dir: Path) -> list:
    manifest_path = observations_dir / "adaptive_run.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"error: manifest not found: {manifest_path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"error: manifest is not valid JSON: {exc}")
    iterations = manifest.get("iterations")
    if not isinstance(iterations, list) or not iterations:
        raise SystemExit("error: manifest has no 'iterations' list.")
    return iterations


def load_validated(observations_dir: Path, iterations: list) -> list:
    """Return [(timestamp, source, validated, speed)] in manifest order."""
    loaded = []
    for position, iteration in enumerate(iterations):
        filename = iteration.get("observation_file")
        if not filename:
            raise SystemExit(
                f"error: iteration {position} has no 'observation_file'."
            )
        path = observations_dir / filename
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise SystemExit(f"error: observation file not found: {path}")
        except json.JSONDecodeError as exc:
            raise SystemExit(f"error: {filename} is not valid JSON: {exc}")
        validated = engine.validate_observation(raw)
        if validated["timestamp"] != iteration.get("timestamp"):
            raise SystemExit(
                f"error: {filename} timestamp {validated['timestamp']!r} "
                f"does not match manifest {iteration.get('timestamp')!r}."
            )
        loaded.append(
            (
                iteration["timestamp"],
                filename,
                validated,
                iteration.get("speed", "NORMAL"),
            )
        )
    return loaded


def schema_usage_stats(loaded: list) -> dict:
    entries = 0
    categories: Counter = Counter()
    with_subjects = 0
    with_action = 0
    with_spatial = 0
    negations = 0
    negation_categories: Counter = Counter()
    for _, _, validated, _ in loaded:
        for entry in validated.get("observations", []):
            entries += 1
            categories[entry.get("category")] += 1
            if entry.get("subjects"):
                with_subjects += 1
            action = entry.get("action")
            if isinstance(action, str) and action.strip():
                with_action += 1
            spatial = entry.get("spatial")
            if isinstance(spatial, str) and spatial.strip():
                with_spatial += 1
            if is_negation_entry(entry.get("description", "")):
                negations += 1
                negation_categories[entry.get("category")] += 1
    return {
        "entries": entries,
        "categories": dict(categories),
        "with_subjects": with_subjects,
        "with_action": with_action,
        "with_spatial": with_spatial,
        "negations": negations,
        "negation_categories": dict(negation_categories),
    }


def run_offline_window(
    prefix: list,
    history: list,
    seen_claim_ids: set,
) -> dict:
    """Mirror run_script_window up to (not including) the model call."""
    state = engine.build_match_state(
        [(timestamp, source, validated) for timestamp, source, validated, _ in prefix]
    )
    events, _counts = engine.detect_events(
        [(timestamp, source, validated) for timestamp, source, validated, _ in prefix],
        state,
    )
    claims, suppressed = engine.gate_commentary_claims(
        [(timestamp, source, validated) for timestamp, source, validated, _ in prefix],
        state,
        events,
    )
    fresh_claims = []
    already_emitted = 0
    for claim in claims:
        claim_id = engine.claim_id_of(claim)
        if claim_id in seen_claim_ids:
            already_emitted += 1
            continue
        seen_claim_ids.add(claim_id)
        fresh_claims.append(dict(claim, claim_id=claim_id))
    model_claims, overflow = engine.prioritize_writer_claims(fresh_claims)
    # Overflow was never sent: release it so a later window can still
    # word it (mirrors run_script_window).
    seen_claim_ids.difference_update(claim["claim_id"] for claim in overflow)
    gameplay = engine.build_gameplay_state(
        [(timestamp, source, validated) for timestamp, source, validated, _ in prefix],
        state,
    )
    narrative_block = engine.render_narrative_block(
        engine.build_narrative(gameplay, state, events, history)
    )
    prompt = engine.build_script_prompt(
        list(model_claims),
        history,
        None,
        intensity=engine.utterance_intensity(list(model_claims)),
        narrative=narrative_block,
    )
    suppressed_by_rule: Counter = Counter(
        entry["rule"] for entry in suppressed
    )
    if already_emitted:
        suppressed_by_rule["already-emitted"] += already_emitted
    if overflow:
        suppressed_by_rule["over-claim-limit"] += len(overflow)
    return {
        "events": events.get("events", []),
        "fresh_claims": fresh_claims,
        "model_claims": list(model_claims),
        "suppressed_by_rule": dict(suppressed_by_rule),
        "narrative_block": narrative_block,
        "prompt": prompt,
    }


def format_counts(mapping: dict) -> str:
    return " ".join(f"{key}={mapping[key]}" for key in sorted(mapping))


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Replay an adaptive run offline up to the model call."
    )
    parser.add_argument("observations_dir", help="Directory with adaptive_run.json.")
    parser.add_argument(
        "--out",
        default="replay_out",
        help="Directory for prompt_window_NN.txt files (default: ./replay_out).",
    )
    args = parser.parse_args(argv)
    observations_dir = Path(args.observations_dir)
    if not observations_dir.is_dir():
        print(f"error: not a directory: {observations_dir}", file=sys.stderr)
        return 1

    iterations = load_iterations(observations_dir)
    loaded = load_validated(observations_dir, iterations)
    stats = schema_usage_stats(loaded)

    print(f"observations: {len(loaded)} validated, 0 failed")
    print(f"entries: {stats['entries']}")
    print(f"category_mix: {format_counts(stats['categories'])}")
    print(f"entries_with_subjects: {stats['with_subjects']}")
    print(f"entries_with_action: {stats['with_action']}")
    print(f"entries_with_spatial: {stats['with_spatial']}")
    print(f"negation_entries: {stats['negations']}")
    print(f"negation_categories: {format_counts(stats['negation_categories'])}")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    history: list = []
    seen_claim_ids: set = set()
    prefix: list = []
    pending = 0
    window_index = 0
    window_min = engine.WINDOW_MIN_OBSERVATIONS

    def emit_window() -> None:
        nonlocal window_index
        window_index += 1
        result = run_offline_window(prefix, history, seen_claim_ids)
        prompt_path = out_dir / f"prompt_window_{window_index:02d}.txt"
        prompt_path.write_text(result["prompt"], encoding="utf-8")
        first_ts = prefix[0][0]
        last_ts = prefix[-1][0]
        print(f"--- window {window_index:02d} "
              f"(observations 1-{len(prefix)}, through {last_ts}s) ---")
        print(f"first_timestamp: {first_ts}")
        print(f"events: {len(result['events'])}")
        for event in result["events"]:
            print(f"  - rule={event.get('rule')} id={event.get('id')} "
                  f"ts={event.get('timestamp')}")
        print(f"fresh_claims: {len(result['fresh_claims'])}")
        for claim in result["fresh_claims"]:
            tags = (claim.get("gameplay") or {}).get("tags", [])
            print(f"  - type={claim.get('type')} "
                  f"rule={claim.get('rule', '-')} "
                  f"tags={','.join(tags) or '-'} "
                  f"ts={claim.get('timestamp')} id={claim.get('claim_id')}")
        print(f"prompt_claims: {len(result['model_claims'])}")
        print(f"suppressed: {format_counts(result['suppressed_by_rule']) or '-'}")
        print(f"narrative: {result['narrative_block'] or '(empty)'}")
        print(f"prompt: {prompt_path} ({len(result['prompt'])} chars)")

    for timestamp, source, validated, speed in loaded:
        prefix.append((timestamp, source, validated, speed))
        pending += 1
        if pending >= window_min or speed == "HIGH":
            emit_window()
            pending = 0
    if pending > 0:
        emit_window()

    print(f"windows: {window_index}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
