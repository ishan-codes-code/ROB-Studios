"""Offline tests for evidence-grounded commentary (--generate-commentary).

No live API calls: validated observation fixtures are built in code, and
state/events snapshots are derived with the production builders. Run
natively from the repository root:
    .venv/bin/python -m unittest discover -s tests -v
"""

import contextlib
import hashlib
import io
import json
import tempfile
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from main import (
    ObservationError,
    build_match_state,
    commentary_claim_id,
    detect_events,
    gate_commentary_claims,
    prioritize_writer_claims,
    render_commentary_claims,
    run_generate_commentary,
    validate_commentary,
)


def obs_item(category, description, confidence="high", evidence="Fixture evidence."):
    return {
        "category": category,
        "description": description,
        "confidence": confidence,
        "evidence": evidence,
    }


def obs_doc(timestamp, items, uncertainties=None):
    return {
        "schema_version": "observation-v1",
        "timestamp": timestamp,
        "observations": items,
        "uncertainties": list(uncertainties or []),
    }


def write_tree(root, docs):
    """Write fixture observations plus derived state/events; return paths.

    ``docs`` maps timestamp -> observation document. Returns
    ``(obs_dir, state_path, events_path, out_path)``.
    """
    root = Path(root)
    obs_dir = root / "observations"
    obs_dir.mkdir(parents=True, exist_ok=True)
    accepted = []
    for timestamp in sorted(docs):
        name = f"frame_{timestamp:05d}.json"
        (obs_dir / name).write_text(
            json.dumps(docs[timestamp], indent=2) + "\n", encoding="utf-8"
        )
        accepted.append((timestamp, name, docs[timestamp]))
    state = build_match_state(list(accepted))
    state_path = obs_dir / "match_state.json"
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    events, _ = detect_events(list(accepted), state)
    events_path = root / "events.json"
    events_path.write_text(json.dumps(events, indent=2) + "\n", encoding="utf-8")
    return obs_dir, state_path, events_path, root / "commentary.json"


def run_capture(*args, **kwargs):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = run_generate_commentary(*args, **kwargs)
    return code, out.getvalue(), err.getvalue()


def read_commentary(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha256_of(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# Gameplay-bearing scene fixtures (vehicle movement / rotation): worthy
# under the broadcast-significance gate, but triggering no event rule,
# so template-mechanics tests stay focused on wording, not echoes.
ENV_A = "A bike speeding past the rocky ledge."
ENV_B = "Squad rotating across the container yard."


class SceneLineTests(unittest.TestCase):
    def test_current_fact_yields_scene_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(0, [obs_item("environment", ENV_A)]),
                    3: obs_doc(
                        3,
                        [
                            obs_item("environment", ENV_A),
                            obs_item("environment", ENV_B),
                        ],
                    ),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        by_template = {}
        for line in doc["lines"]:
            by_template.setdefault(line["template"], []).append(line)
        self.assertIn("scene_visible", by_template)
        # Fact B also has a development line for the same new evidence,
        # so its scene twin is subsumed; only fact A keeps scene wording.
        self.assertEqual(len(by_template["scene_visible"]), 1)
        scene = by_template["scene_visible"][0]
        self.assertEqual(scene["type"], "scene")
        self.assertIn(ENV_A, scene["text"])
        self.assertIsNone(scene["qualification"])
        self.assertIsNone(scene["event_id"])
        self.assertEqual(scene["confidence"], "high")
        self.assertEqual(doc["prior_commentary"]["status"], "absent")
        self.assertIn("valid-inputs", doc["rules_evaluated"])

    def test_hud_reading_quotes_without_meaning(self):
        hud_text = "Compass shows the squad rotating east."
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(
                        0,
                        [obs_item("hud", hud_text)],
                    ),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        # The reading is new evidence, so it is spoken once as a
        # development line (verbatim quote, no interpreted meaning) while
        # its scene twin is subsumed.
        self.assertEqual(len(doc["lines"]), 1)
        line = doc["lines"][0]
        self.assertEqual(line["type"], "development")
        self.assertEqual(line["text"], f"New development: {hud_text}")

    def test_persisting_reading_uses_hud_template(self):
        hud_text = "Compass shows the squad rotating east."
        hud = obs_item("hud", hud_text)
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(
                        0,
                        [obs_item("environment", ENV_A), hud],
                    ),
                    3: obs_doc(
                        3,
                        [obs_item("environment", ENV_A), hud],
                    ),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        # No latest-timestamp change: nothing is new, so the persisting
        # reading keeps plain scene wording with the hud template.
        hud_lines = [line for line in doc["lines"] if line["template"] == "hud_reading"]
        self.assertEqual(len(hud_lines), 1)
        self.assertTrue(hud_lines[0]["text"].startswith("HUD reads: "))
        self.assertIn(hud_text, hud_lines[0]["text"])

    def test_development_line_for_latest_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(0, [obs_item("environment", ENV_A)]),
                    3: obs_doc(
                        3,
                        [
                            obs_item("environment", ENV_A),
                            obs_item("environment", ENV_B),
                        ],
                    ),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        new_lines = [line for line in doc["lines"] if line["template"] == "development_new"]
        self.assertEqual(len(new_lines), 1)
        self.assertEqual(new_lines[0]["type"], "development")
        self.assertIn(ENV_B, new_lines[0]["text"])


class EventEchoTests(unittest.TestCase):
    def test_candidate_described_with_qualifier(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(0, [obs_item("environment", ENV_A)]),
                    3: obs_doc(
                        3,
                        [
                            obs_item("environment", ENV_A),
                            obs_item(
                                "hud",
                                "Kill feed shows a fresh entry.",
                                "high",
                                "RRQ.JEEK eliminated OG.IQOOPAWDI in the kill feed",
                            ),
                        ],
                    ),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        echoes = [line for line in doc["lines"] if line["type"] == "event_echo"]
        self.assertEqual(len(echoes), 1)
        echo = echoes[0]
        self.assertEqual(echo["template"], "event_echo")
        self.assertIsNotNone(echo["event_id"])
        self.assertIsNotNone(echo["qualification"])
        # The qualifier stays internal-only: spoken text uses cautious
        # grounded wording with no leaked validation language.
        self.assertIn("a possible development, details still unclear", echo["text"])
        self.assertNotIn("unconfirmed", echo["text"])
        self.assertNotIn("not established", echo["text"])
        self.assertIn("RRQ.JEEK", echo["text"])


class SuppressionTests(unittest.TestCase):
    def test_vanished_nameplate_is_stale_not_a_kill(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(
                        0,
                        [
                            obs_item("environment", ENV_A),
                            obs_item(
                                "character",
                                "Nameplate RRQ.DUTZZ on the cliff edge.",
                            ),
                        ],
                    ),
                    3: obs_doc(3, [obs_item("environment", ENV_A)]),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        for line in doc["lines"]:
            self.assertNotIn("eliminat", line["text"].lower())
            self.assertNotIn("kill", line["text"].lower())
        rules = {entry["rule"] for entry in doc["suppressed"]}
        self.assertIn("stale-fact", rules)

    def test_low_confidence_claim_suppressed(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(
                        0,
                        [obs_item("hud", "Blurry counter digits.", "low")],
                    ),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        self.assertEqual(doc["lines"], [])
        rules = {entry["rule"] for entry in doc["suppressed"]}
        self.assertIn("confidence-floor", rules)

    def test_uncertainty_scope_suppresses_quoted_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(
                        0,
                        [
                            obs_item(
                                "character",
                                "Nameplate RRQ.JEEK near the bones.",
                            )
                        ],
                        uncertainties=["RRQ.JEEK is too small to read reliably."],
                    ),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        self.assertEqual(doc["lines"], [])
        rules = {entry["rule"] for entry in doc["suppressed"]}
        self.assertIn("uncertainty-scope", rules)

    def test_conflicted_evidence_suppressed(self):
        doc_a = obs_doc(0, [obs_item("environment", ENV_A)])
        doc_b = obs_doc(0, [obs_item("environment", ENV_B)])
        accepted = [(0, "a.json", doc_a), (0, "b.json", doc_b)]
        state = build_match_state(list(accepted))
        self.assertTrue(state["conflicts"])
        events, _ = detect_events(list(accepted), state)
        claims, suppressed = gate_commentary_claims(list(accepted), state, events)
        self.assertEqual(claims, [])
        rules = {entry["rule"] for entry in suppressed}
        self.assertIn("no-conflicted-evidence", rules)

    def test_combat_category_never_scene(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(
                        0,
                        [obs_item("combat", "Figures hold positions.")],
                    ),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        self.assertEqual(doc["lines"], [])
        rules = {entry["rule"] for entry in doc["suppressed"]}
        self.assertIn("category-scope", rules)


class RepetitionTests(unittest.TestCase):
    def test_second_run_suppresses_unchanged_claims(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp, {0: obs_doc(0, [obs_item("environment", ENV_A)])}
            )
            kwargs = dict(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            code, _, _ = run_capture(**kwargs)
            self.assertEqual(code, 0)
            first = read_commentary(out)
            self.assertTrue(first["lines"])
            self.assertEqual(first["prior_commentary"]["status"], "absent")
            code, _, _ = run_capture(**kwargs)
            self.assertEqual(code, 0)
            second = read_commentary(out)
            self.assertEqual(second["lines"], [])
            self.assertEqual(second["prior_commentary"]["status"], "ok")
            rules = {entry["rule"] for entry in second["suppressed"]}
            self.assertIn("already-emitted", rules)

    def test_third_run_stays_silent(self):
        # Silence must converge: the second run's file carries no lines,
        # so the third run suppresses via its already-emitted records
        # instead of re-emitting everything.
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp, {0: obs_doc(0, [obs_item("environment", ENV_A)])}
            )
            kwargs = dict(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            for _ in range(2):
                code, _, _ = run_capture(**kwargs)
                self.assertEqual(code, 0)
            code, _, _ = run_capture(**kwargs)
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        self.assertEqual(doc["lines"], [])
        rules = {entry["rule"] for entry in doc["suppressed"]}
        self.assertIn("already-emitted", rules)

    def test_malformed_prior_file_degrades_to_first_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp, {0: obs_doc(0, [obs_item("environment", ENV_A)])}
            )
            out.write_text("{not valid json", encoding="utf-8")
            code, _, err = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
            self.assertTrue(doc["lines"])
            self.assertEqual(doc["prior_commentary"]["status"], "ignored-malformed")
            self.assertIn("malformed prior commentary", err)

    def test_claim_id_stable_and_timestamp_sensitive(self):
        first = commentary_claim_id("scene", "scene_visible", [ENV_A], ["f0001"], 3)
        again = commentary_claim_id("scene", "scene_visible", [ENV_A], ["f0001"], 3)
        later = commentary_claim_id("scene", "scene_visible", [ENV_A], ["f0001"], 6)
        self.assertEqual(first, again)
        self.assertNotEqual(first, later)


class SilenceAndFailureTests(unittest.TestCase):
    def test_silence_is_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(
                        0,
                        [obs_item("hud", "Blurry counter digits.", "low")],
                    ),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        self.assertEqual(doc["lines"], [])
        self.assertTrue(doc["suppressed"])

    def test_malformed_observation_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            obs_dir = root / "observations"
            obs_dir.mkdir(parents=True, exist_ok=True)
            (obs_dir / "frame_00000.json").write_text("{broken", encoding="utf-8")
            out = root / "commentary.json"
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=obs_dir / "match_state.json",
                events_path=root / "events.json",
                commentary_path=out,
            )
        self.assertEqual(code, 1)
        self.assertFalse(out.is_file())

    def test_stale_state_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp, {0: obs_doc(0, [obs_item("environment", ENV_A)])}
            )
            (obs_dir / "frame_00003.json").write_text(
                json.dumps(obs_doc(3, [obs_item("environment", ENV_A)])),
                encoding="utf-8",
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
        self.assertEqual(code, 1)
        self.assertFalse(out.is_file())

    def test_stale_events_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(0, [obs_item("environment", ENV_A)]),
                    3: obs_doc(3, [obs_item("environment", ENV_A)]),
                },
            )
            # Regenerate events from only the first observation: stale cover.
            first = [(0, "frame_00000.json", obs_doc(0, [obs_item("environment", ENV_A)]))]
            state = build_match_state(list(first))
            events, _ = detect_events(list(first), state)
            ev.write_text(json.dumps(events, indent=2) + "\n", encoding="utf-8")
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
        self.assertEqual(code, 1)
        self.assertFalse(out.is_file())


class OutputValidationTests(unittest.TestCase):
    def _bundle(self):
        docs = {0: obs_doc(0, [obs_item("environment", ENV_A)])}
        accepted = [(0, "frame_00000.json", docs[0])]
        state = build_match_state(list(accepted))
        events, _ = detect_events(list(accepted), state)
        claims, _ = gate_commentary_claims(list(accepted), state, events)
        lines = render_commentary_claims(claims)
        bundle = {
            "observations": {"frame_00000.json": docs[0]},
            "state": state,
            "events": events,
        }
        document = {
            "schema_version": "commentary-v1",
            "generated_from": {
                "observations": ["frame_00000.json"],
                "match_state": "match_state.json",
                "events": "events.json",
            },
            "prior_commentary": {"file": "commentary.json", "status": "absent"},
            "rules_evaluated": ["valid-inputs"],
            "lines": lines,
            "suppressed": [],
        }
        return document, bundle

    def test_rendered_output_validates_with_bundle(self):
        document, bundle = self._bundle()
        self.assertTrue(document["lines"])
        validate_commentary(document, bundle)

    def test_unknown_template_rejected(self):
        document, bundle = self._bundle()
        document["lines"][0]["template"] = "epic_saga"
        with self.assertRaises(ObservationError):
            validate_commentary(document, bundle)

    def test_missing_qualification_rejected(self):
        document, bundle = self._bundle()
        document["lines"][0]["type"] = "event_echo"
        with self.assertRaises(ObservationError):
            validate_commentary(document, bundle)

    def test_stray_qualification_rejected(self):
        document, bundle = self._bundle()
        document["lines"][0]["qualification"] = "definitely confirmed"
        with self.assertRaises(ObservationError):
            validate_commentary(document, bundle)

    def test_confidence_ceiling_enforced(self):
        document, bundle = self._bundle()
        bundle["state"]["facts"][0]["confidence"] = "low"
        with self.assertRaises(ObservationError):
            validate_commentary(document, bundle)

    def test_token_outside_evidence_rejected(self):
        document, bundle = self._bundle()
        document["lines"][0]["text"] += " RRQ.INVENTED"
        with self.assertRaises(ObservationError):
            validate_commentary(document, bundle)

    def test_evidence_must_be_in_line_text(self):
        document, bundle = self._bundle()
        document["lines"][0]["text"] = "Something entirely different."
        with self.assertRaises(ObservationError):
            validate_commentary(document, bundle)


class PreservationTests(unittest.TestCase):
    def test_upstream_files_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(0, [obs_item("environment", ENV_A)]),
                    3: obs_doc(3, [obs_item("environment", ENV_A)]),
                },
            )
            before = {
                path: sha256_of(path)
                for path in list(obs_dir.glob("*.json")) + [st, ev]
            }
            code, _, _ = run_capture(
                observations_dir=obs_dir,
                state_path=st,
                events_path=ev,
                commentary_path=out,
            )
            self.assertEqual(code, 0)
            after = {
                path: sha256_of(path)
                for path in list(obs_dir.glob("*.json")) + [st, ev]
            }
            self.assertEqual(before, after)


SEQ_ELIM_4 = obs_item(
    "hud",
    "Bottom-left team panel for team AG showing members AG.BAROS and "
    "AG.SAIFA, plus header 'Elim 4'.",
    "high",
    "Team AG panel header Elim 4.",
)
SEQ_ELIM_5 = obs_item(
    "hud",
    "Bottom-left team panel for team AG showing members AG.BAROS and "
    "AG.NAMELESS, plus header 'Elim 5'.",
    "high",
    "Team AG panel header Elim 5.",
)
SEQ_ELIM_6 = obs_item(
    "hud",
    "Bottom-left team panel for team AG showing members AG.BAROS and "
    "AG.SOLO, plus header 'Elim 6'.",
    "high",
    "Team AG panel header Elim 6.",
)
SEQ_FEED_A = obs_item(
    "hud",
    "Top-right kill feed lines show recent eliminations.",
    "high",
    "Feed lines read 'RRQ.JEEK eliminated OG.IQOOPAWDI' and "
    "'SBUL.BUNNY eliminated TAG.VIPER'.",
)
SEQ_FEED_B = obs_item(
    "hud",
    "Top-right kill feed shows two more fresh entries.",
    "high",
    "Feed lines read 'TLX.ALPHA eliminated VPE.BRAVO' and "
    "'NVX.CHARLIE eliminated DRX.DELTA'.",
)


def sequence_bundle(root):
    obs_dir, st, ev, out = write_tree(
        root,
        {
            0: obs_doc(0, [SEQ_ELIM_4]),
            3: obs_doc(3, [SEQ_ELIM_5, SEQ_FEED_A]),
            6: obs_doc(6, [SEQ_ELIM_6, SEQ_FEED_B]),
        },
    )
    return obs_dir, st, ev, out


def load_bundle(obs_dir, state_path, events_path, docs):
    accepted = {}
    for timestamp in sorted(docs):
        accepted[f"frame_{timestamp:05d}.json"] = docs[timestamp]
    state = json.loads(Path(state_path).read_text(encoding="utf-8"))
    events = json.loads(Path(events_path).read_text(encoding="utf-8"))
    return {"observations": accepted, "state": state, "events": events}


class EventSequenceTests(unittest.TestCase):
    def test_streak_yields_sequence_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(0, [SEQ_ELIM_4]),
                    3: obs_doc(3, [SEQ_ELIM_5]),
                    6: obs_doc(6, [SEQ_ELIM_6]),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir, state_path=st,
                events_path=ev, commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        sequences = [line for line in doc["lines"]
                     if line["template"] == "event_sequence"]
        self.assertEqual(len(sequences), 1)
        line = sequences[0]
        self.assertEqual(line["type"], "event_echo")
        self.assertEqual(line["timestamp"], 6)
        self.assertIsNotNone(line["event_id"])
        self.assertIn("not established", line["qualification"])
        self.assertTrue(line["text"].startswith("Sequence developing:"))
        self.assertNotIn("unconfirmed", line["text"])
        for quote in line["evidence"]:
            self.assertIn(quote, line["text"])

    def test_cluster_yields_sequence_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp,
                {
                    0: obs_doc(0, [SEQ_FEED_A]),
                    3: obs_doc(3, [SEQ_FEED_B]),
                },
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir, state_path=st,
                events_path=ev, commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        sequences = [line for line in doc["lines"]
                     if line["template"] == "event_sequence"]
        self.assertEqual(len(sequences), 1)
        self.assertEqual(sequences[0]["timestamp"], 3)
        self.assertIn("RRQ.JEEK", sequences[0]["text"])

    def test_single_feed_still_echoes(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = write_tree(
                tmp, {0: obs_doc(0, [SEQ_FEED_A])}
            )
            code, _, _ = run_capture(
                observations_dir=obs_dir, state_path=st,
                events_path=ev, commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
        templates = [line["template"] for line in doc["lines"]]
        self.assertIn("event_echo", templates)
        self.assertNotIn("event_sequence", templates)

    def test_unknown_rule_suppressed(self):
        docs = {
            0: obs_doc(0, [SEQ_ELIM_4]),
            3: obs_doc(3, [SEQ_ELIM_5]),
            6: obs_doc(6, [SEQ_ELIM_6]),
        }
        accepted = [(ts, f"frame_{ts:05d}.json", docs[ts])
                    for ts in sorted(docs)]
        state = build_match_state(list(accepted))
        events, _ = detect_events(list(accepted), state)
        streak = [e for e in events["events"] if e["type"] == "elim_streak"][0]
        streak["rule"] = "bogus/v1"
        _claims, suppressed = gate_commentary_claims(
            list(accepted), state, events
        )
        subjects = [entry["subject"] for entry in suppressed
                    if entry["rule"] == "no-justified-wording"]
        self.assertIn(f"event '{streak['id']}'", subjects)

    def test_gate_orders_echoes_by_significance(self):
        docs = {
            0: obs_doc(0, [SEQ_ELIM_4]),
            3: obs_doc(3, [SEQ_ELIM_5, SEQ_FEED_A]),
            6: obs_doc(6, [SEQ_ELIM_6, SEQ_FEED_B]),
        }
        accepted = [(ts, f"frame_{ts:05d}.json", docs[ts])
                    for ts in sorted(docs)]
        state = build_match_state(list(accepted))
        events, _ = detect_events(list(accepted), state)
        claims, _ = gate_commentary_claims(list(accepted), state, events)
        echoes = [c for c in claims if c["type"] == "event_echo"]
        self.assertEqual(
            [c["rule"] for c in echoes],
            ["feed_cluster", "elim_streak", "elim_count_increased",
             "elim_count_increased", "kill_feed_entry", "kill_feed_entry"],
        )
        self.assertEqual(
            [c["template"] for c in echoes[:2]],
            ["event_sequence", "event_sequence"],
        )

    def test_rendered_echoes_follow_significance(self):
        with tempfile.TemporaryDirectory() as tmp:
            obs_dir, st, ev, out = sequence_bundle(tmp)
            code, _, _ = run_capture(
                observations_dir=obs_dir, state_path=st,
                events_path=ev, commentary_path=out,
            )
            self.assertEqual(code, 0)
            doc = read_commentary(out)
            events = json.loads(Path(ev).read_text(encoding="utf-8"))
        rule_of = {e["id"]: e["rule"].split("/")[0]
                   for e in events["events"]}
        ordered = [rule_of[line["event_id"]] for line in doc["lines"]
                   if line["type"] == "event_echo" and line["timestamp"] == 6]
        self.assertEqual(
            ordered,
            ["feed_cluster", "elim_streak", "elim_count_increased",
             "kill_feed_entry"],
        )


class SequenceProvenanceTests(unittest.TestCase):
    def run_tree(self, tmp, docs):
        obs_dir, st, ev, out = write_tree(tmp, docs)
        code, _, _ = run_capture(
            observations_dir=obs_dir, state_path=st,
            events_path=ev, commentary_path=out,
        )
        self.assertEqual(code, 0)
        return read_commentary(out), load_bundle(obs_dir, st, ev, docs)

    def test_sequence_line_passes_bundle_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = {
                0: obs_doc(0, [SEQ_ELIM_4]),
                3: obs_doc(3, [SEQ_ELIM_5]),
                6: obs_doc(6, [SEQ_ELIM_6]),
            }
            doc, bundle = self.run_tree(tmp, docs)
        validate_commentary(doc, bundle)

    def test_sequence_qualification_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = {0: obs_doc(0, [SEQ_FEED_A]), 3: obs_doc(3, [SEQ_FEED_B])}
            doc, _bundle = self.run_tree(tmp, docs)
        line = [entry for entry in doc["lines"]
                if entry["template"] == "event_sequence"][0]
        line["qualification"] = None
        with self.assertRaises(ObservationError):
            validate_commentary(doc)

    def test_sequence_confidence_ceiling(self):
        # The enforced rule for all templates: a line stronger than
        # its weakest cited source is rejected; a weaker line passes.
        medium_feed_b = dict(SEQ_FEED_B, confidence="medium")
        with tempfile.TemporaryDirectory() as tmp:
            docs = {
                0: obs_doc(0, [SEQ_FEED_A]),
                3: obs_doc(3, [medium_feed_b]),
            }
            doc, bundle = self.run_tree(tmp, docs)
        validate_commentary(doc, bundle)
        line = [entry for entry in doc["lines"]
                if entry["template"] == "event_sequence"][0]
        self.assertEqual(line["confidence"], "medium")
        line["confidence"] = "high"
        with self.assertRaises(ObservationError):
            validate_commentary(doc, bundle)
        line["confidence"] = "low"
        validate_commentary(doc, bundle)

    def test_event_claim_capped_at_weakest_cited_fact(self):
        # The AG4 fact is re-sighted weaker after the pair fired: the
        # echo claim inherits the weakest cited confidence, never the
        # event's own stronger label.
        weak_again = dict(SEQ_ELIM_4, confidence="medium")
        with tempfile.TemporaryDirectory() as tmp:
            docs = {
                0: obs_doc(0, [SEQ_ELIM_4]),
                3: obs_doc(3, [SEQ_ELIM_6]),
                6: obs_doc(6, [weak_again]),
            }
            accepted = [
                (ts, f"frame_{ts:05d}.json", docs[ts]) for ts in sorted(docs)
            ]
            state = build_match_state(list(accepted))
            events, _ = detect_events(list(accepted), state)
            event = [e for e in events["events"]
                     if e["rule"] == "elim_count_increased/v1"][0]
            self.assertEqual(event["confidence"], "high")
            claims, _ = gate_commentary_claims(list(accepted), state, events)
        echoes = [c for c in claims
                  if c["type"] == "event_echo"
                  and c["rule"] == "elim_count_increased"]
        self.assertEqual(len(echoes), 1)
        self.assertEqual(echoes[0]["confidence"], "medium")

    def test_sequence_token_subset(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = {0: obs_doc(0, [SEQ_FEED_A]), 3: obs_doc(3, [SEQ_FEED_B])}
            doc, bundle = self.run_tree(tmp, docs)
        line = [entry for entry in doc["lines"]
                if entry["template"] == "event_sequence"][0]
        line["text"] = line["text"] + " ZZZ.QQQ"
        with self.assertRaises(ObservationError):
            validate_commentary(doc, bundle)


class SignificanceTests(unittest.TestCase):
    def echo_claim(self, rule, source_id, timestamp=6):
        template = ("event_sequence" if rule in
                    ("elim_streak", "feed_cluster") else "event_echo")
        return {
            "type": "event_echo",
            "template": template,
            "timestamp": timestamp,
            "source_ids": [source_id],
            "rule": rule,
        }

    def test_prioritize_orders_echoes_by_significance(self):
        claims = [
            self.echo_claim("kill_feed_entry", "f4"),
            self.echo_claim("elim_count_increased", "f3"),
            self.echo_claim("elim_streak", "f2"),
            self.echo_claim("feed_cluster", "f1"),
        ]
        model, overflow = prioritize_writer_claims(claims)
        self.assertEqual(overflow, [])
        self.assertEqual(
            [c["rule"] for c in model],
            ["feed_cluster", "elim_streak", "elim_count_increased",
             "kill_feed_entry"],
        )

    def test_tie_break_is_deterministic(self):
        first = self.echo_claim("elim_streak", "f9")
        second = self.echo_claim("elim_streak", "f1")
        model, _ = prioritize_writer_claims([first, second])
        self.assertEqual(
            [c["source_ids"] for c in model], [["f1"], ["f9"]]
        )
        again, _ = prioritize_writer_claims([second, first])
        self.assertEqual(
            [c["source_ids"] for c in again], [["f1"], ["f9"]]
        )


if __name__ == "__main__":
    unittest.main()
