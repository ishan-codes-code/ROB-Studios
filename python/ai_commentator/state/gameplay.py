"""Deterministic gameplay interpretation over validated observations.

This module is the interpretation layer between raw vision output and
gameplay reasoning. It reads validated ``observation-v1``/``observation-v2``
documents (including the v2 structured keys ``subjects``/``action``/
``spatial``, which no other consumer used before) and derives a bounded,
in-memory ``gameplay-v1`` document:

- per-entry **signals**: what the wording directly supports (``observed``)
  versus what it merely suggests (``inferred``). Inferred signals are
  never promoted silently: single-sighting event rules may only read
  ``observed`` signals, and temporal rules additionally require two or
  more sightings.
- **entity tracks**: cautiously maintained identities keyed by exact
  on-screen label. Similar labels are never merged, unlabeled sightings
  are never linked across frames, and a gap in sightings means
  ``occluded`` — never eliminated.

The document is derived deterministically from the same inputs as match
state (plus the state snapshot for latest-timestamp/status context) and
is rebuilt in memory wherever it is needed. It is never persisted to
disk, so there is no new artifact, no migration, and no stale-snapshot
surface: replaying the same observations always yields the same bytes.
"""

from __future__ import annotations

from ..config import EVENT_NAME_RE
from ..errors import ObservationError
from ..vision.observations import _reject_extra, _require_non_empty_string
from .match_state import fact_key


GAMEPLAY_SCHEMA_VERSION = "gameplay-v1"

#: Gap between consecutive sightings after which a returning entity is
#: flagged ``reappeared`` rather than continuously observed. Initial
#: engineering value (twice the default sampling interval); tune against
#: real footage.
ENTITY_REAPPEAR_GAP_S = 6.0

#: Posture words read verbatim from entry text. ``knocked``/``downed``/
#: ``crawling`` describe a player who is down — never an elimination.
#: Order is specificity-first: when several match, the earliest wins, so a
#: concrete body posture (``crawling``) beats a state word (``knocked``).
POSTURE_WORDS = (
    "crawling",
    "prone",
    "lying",
    "standing",
    "crouched",
    "crouching",
    "kneeling",
    "sitting",
    "running",
    "walking",
    "knocked",
    "downed",
)

#: Combat-activity words. Generic on their own; engagement rules require
#: corroboration across sightings.
COMBAT_WORDS = (
    "firing",
    "fired",
    "shooting",
    "shots",
    "gunfire",
    "exchange",
    "firefight",
    "muzzle",
    "tracer",
    "hitmarker",
    "damage",
)

#: Explicit knockdown wording. Fires knockdown candidates, never
#: eliminations.
KNOCKDOWN_WORDS = ("knocked", "knock down", "knocked down", "downed", "crawling")

#: Explicit revive wording. A reappearing player without these words is
#: reappearance, never a revive.
REVIVE_WORDS = ("revive", "reviving", "revived")

#: Free Fire cover wording. "Gloo Wall" is the item alias; both name the
#: same cover and neither is a conventional shield.
BLUE_WALL_WORDS = ("blue wall", "gloo wall", "gloo")

#: Throwable wording.
GRENADE_WORDS = ("grenade", "frag", "throwable", "molotov", "flashbang")
SMOKE_WORDS = ("smoke",)

#: Vehicle wording.
VEHICLE_WORDS = (
    "vehicle",
    "car",
    "bike",
    "motorbike",
    "boat",
    "truck",
    "jeep",
    "buggy",
    "uaz",
    "sedan",
    "driving",
)

#: Zone/match-progression wording.
ZONE_WORDS = (
    "safe zone",
    "safe-zone",
    "shrinking",
    "zone",
    "circle",
    "blue zone",
    "red zone",
    "outside the zone",
    "outside zone",
)

#: Elimination-outcome wording. Only explicit outcome words count; knocks,
#: absences, and rewordings never match.
ELIM_WORDS = (
    "eliminated",
    "elimination",
    "killed",
    "kill confirmed",
    "finished",
    "flush",
)

#: Movement wording. A single movement word is only a cue; confirmed
#: repositioning requires differing spatial phrases across sightings.
MOVEMENT_WORDS = (
    "moving",
    "rotating",
    "rotation",
    "repositioning",
    "advancing",
    "pushing",
    "retreating",
    "running",
    "driving",
)

#: Scenery nouns used by the broadcast-significance policy to recognize
#: standalone environment descriptions. Matching nouns suppress nothing
#: on their own; they only mark a claim as scenery-flavored so the gate
#: can require a gameplay link before speaking it.
SCENERY_WORDS = (
    "grass",
    "road",
    "building",
    "billboard",
    "tree",
    "rock",
    "wall",
    "house",
    "field",
    "scenery",
    "landscape",
)

_SIGNAL_WORD_FIELDS = (
    ("posture", POSTURE_WORDS),
    ("combat", COMBAT_WORDS),
    ("knockdown", KNOCKDOWN_WORDS),
    ("revive", REVIVE_WORDS),
    ("blue_wall", BLUE_WALL_WORDS),
    ("grenade", GRENADE_WORDS),
    ("smoke", SMOKE_WORDS),
    ("vehicle", VEHICLE_WORDS),
    ("zone", ZONE_WORDS),
    ("elim", ELIM_WORDS),
    ("movement", MOVEMENT_WORDS),
    ("scenery", SCENERY_WORDS),
)


def _entry_text(entry: dict) -> str:
    """Lowercased searchable text of one validated observation entry."""
    parts = [entry.get("description", ""), entry.get("evidence", "")]
    action = entry.get("action")
    spatial = entry.get("spatial")
    if isinstance(action, str):
        parts.append(action)
    if isinstance(spatial, str):
        parts.append(spatial)
    for subject in entry.get("subjects", []) or []:
        if isinstance(subject, dict) and isinstance(subject.get("label"), str):
            parts.append(subject["label"])
    return " ".join(part for part in parts if part).lower()


def _name_tokens(text: str) -> list[str]:
    """Distinct ``TAG.NAME`` tokens in encounter order."""
    tokens = []
    for match in EVENT_NAME_RE.finditer(text):
        token = match.group(0)
        if token not in tokens:
            tokens.append(token)
    return tokens


def entry_signals(entry: dict) -> dict:
    """Derive deterministic signals for one validated observation entry.

    Returns ``{"observed": [...], "inferred": [...], "entities": [...],
    "posture": str | None}`` with sorted, deduplicated tag lists.
    ``observed`` tags name wording directly present; ``inferred`` tags
    name weak suggestions that require corroboration before any rule may
    act on them. Never raises on missing optional keys (v1 entries and
    v1-shaped v2 entries simply yield fewer tags).
    """
    text = _entry_text(entry)
    observed: set[str] = set()
    for tag, words in _SIGNAL_WORD_FIELDS:
        if any(word in text for word in words):
            observed.add(tag)
    entities: list[dict] = []
    seen_labels: set[str] = set()
    for subject in entry.get("subjects", []) or []:
        if not isinstance(subject, dict):
            continue
        label = subject.get("label")
        if not isinstance(label, str) or not label.strip() or label in seen_labels:
            continue
        seen_labels.add(label)
        entities.append(
            {"label": label, "kind": subject.get("kind", "other")}
        )
    for token in _name_tokens(
        f"{entry.get('description', '')} {entry.get('evidence', '')}"
    ):
        if token not in seen_labels:
            seen_labels.add(token)
            entities.append({"label": token, "kind": "token"})
    if entities:
        observed.add("entity_mention")
    if isinstance(entry.get("action"), str) and entry["action"].strip():
        observed.add("action_quoted")
    if isinstance(entry.get("spatial"), str) and entry["spatial"].strip():
        observed.add("spatial_quoted")
    posture = None
    for word in POSTURE_WORDS:
        if word in text:
            posture = word
            break
    inferred: set[str] = set()
    if "combat" in observed and "entity_mention" in observed:
        inferred.add("possible_engagement_cue")
    if "movement" in observed and "entity_mention" in observed:
        inferred.add("possible_movement_cue")
    if "zone" in observed and "entity_mention" in observed:
        inferred.add("possible_zone_pressure_cue")
    return {
        "observed": sorted(observed),
        "inferred": sorted(inferred),
        "entities": sorted(entities, key=lambda item: item["label"]),
        "posture": posture,
    }


def _track_status(sightings: list, latest: float | int | None) -> str:
    """Derive one entity track status from its sightings.

    ``observed``: seen at the latest timestamp. ``reappeared``: seen at
    the latest timestamp after a gap wider than
    :data:`ENTITY_REAPPEAR_GAP_S`. ``occluded``: not seen lately — a gap
    in visibility, never an elimination or a departure claim.
    """
    ordered = sorted(sightings, key=lambda item: (item["timestamp"], item["source"]))
    gaps = [
        ordered[index + 1]["timestamp"] - ordered[index]["timestamp"]
        for index in range(len(ordered) - 1)
    ]
    if latest is not None and ordered[-1]["timestamp"] == latest:
        if any(gap > ENTITY_REAPPEAR_GAP_S for gap in gaps):
            return "reappeared"
        return "observed"
    return "occluded"


def build_entity_tracks(accepted: list) -> list:
    """Build cautious entity tracks over validated observations.

    ``accepted`` is ``[(timestamp, source, validated)]``. Sightings group
    by exact label string only — similar labels are never merged, and an
    entry without an entity label yields an unlinked ``unknown-`` track
    that can never join another sighting. Movement is flagged only when
    two non-empty spatial phrases differ across sightings of the same
    track. Tracks sort by ``(first_seen, ref)``; sightings sort by
    ``(timestamp, source)``. Deterministic: the same inputs always yield
    the same tracks.
    """
    sightings_by_label: dict[str, dict] = {}
    unknown_tracks: list[dict] = []
    for timestamp, source_name, validated in accepted:
        for index, entry in enumerate(validated.get("observations", [])):
            signals = entry_signals(entry)
            spatial = entry.get("spatial")
            spatial_text = spatial.strip() if isinstance(spatial, str) else ""
            action = entry.get("action")
            action_text = action.strip() if isinstance(action, str) else ""
            sighting = {
                "timestamp": timestamp,
                "source": source_name,
                "fact_key": list(
                    fact_key(entry.get("category", ""), entry.get("description", ""))
                ),
                "spatial": spatial_text,
                "action": action_text,
                "posture": signals["posture"],
                "observed": signals["observed"],
            }
            if not signals["entities"]:
                unknown_tracks.append(
                    {
                        "ref": f"unknown-{source_name}-{index}",
                        "kind": "unknown",
                        "identity": "unknown",
                        "sightings": [sighting],
                    }
                )
                continue
            for entity in signals["entities"]:
                track = sightings_by_label.setdefault(
                    entity["label"],
                    {
                        "ref": entity["label"],
                        "kind": entity["kind"],
                        "identity": "exact-label",
                        "sightings": [],
                    },
                )
                # The same entry may name a label twice (subjects plus a
                # bare token); record one sighting per entry per label.
                if not any(
                    item["timestamp"] == timestamp and item["source"] == source_name
                    for item in track["sightings"]
                ):
                    track["sightings"].append(dict(sighting))
    latest = None
    for timestamp, _, _ in accepted:
        if latest is None or timestamp > latest:
            latest = timestamp
    tracks = []
    for track in list(sightings_by_label.values()) + unknown_tracks:
        sightings = sorted(
            track["sightings"], key=lambda item: (item["timestamp"], item["source"])
        )
        spatials = [item["spatial"] for item in sightings if item["spatial"]]
        movement = None
        if len(spatials) >= 2 and spatials[0].lower() != spatials[-1].lower():
            movement = {"from": spatials[0], "to": spatials[-1]}
        postures = [item["posture"] for item in sightings if item["posture"]]
        tracks.append(
            {
                "ref": track["ref"],
                "kind": track["kind"],
                "identity": track["identity"],
                "first_seen": sightings[0]["timestamp"],
                "last_seen": sightings[-1]["timestamp"],
                "status": _track_status(sightings, latest),
                "posture": postures[-1] if postures else None,
                "movement": movement,
                "sightings": sightings,
            }
        )
    tracks.sort(key=lambda item: (item["first_seen"], item["ref"]))
    return tracks


def build_gameplay_state(accepted: list, state: dict) -> dict:
    """Build the in-memory ``gameplay-v1`` interpretation document.

    ``accepted`` is ``[(timestamp, source, validated)]`` with validated
    observations; ``state`` is the ``match-state-v1`` snapshot for
    latest-timestamp context. Signals file under exact fact keys so
    gating can ask what gameplay a fact carries without fuzzy matching.
    The result is validated before return and contains no wall-clock
    time, so the same inputs always yield the same document.
    """
    signals_by_fact: dict[tuple, dict] = {}
    for _, _, validated in accepted:
        for entry in validated.get("observations", []):
            key = fact_key(entry.get("category", ""), entry.get("description", ""))
            signals = entry_signals(entry)
            merged = signals_by_fact.setdefault(
                key, {"observed": set(), "inferred": set(), "entities": {}}
            )
            merged["observed"].update(signals["observed"])
            merged["inferred"].update(signals["inferred"])
            for entity in signals["entities"]:
                merged["entities"].setdefault(entity["label"], entity["kind"])
    facts = []
    for (category, description), merged in sorted(signals_by_fact.items()):
        facts.append(
            {
                "category": category,
                "description": description,
                "observed": sorted(merged["observed"]),
                "inferred": sorted(merged["inferred"]),
                "entities": [
                    {"label": label, "kind": kind}
                    for label, kind in sorted(merged["entities"].items())
                ],
            }
        )
    tracks = build_entity_tracks(accepted)
    latest = state.get("latest_timestamp")
    combat_active = any(
        "combat" in item["observed"]
        for item in signals_by_fact.values()
    ) and any(
        timestamp == latest for timestamp, _, _ in accepted
    )
    document = {
        "schema_version": GAMEPLAY_SCHEMA_VERSION,
        "latest_timestamp": latest,
        "fact_signals": facts,
        "entities": tracks,
        "summary": {
            "entity_count": sum(
                1 for track in tracks if track["identity"] == "exact-label"
            ),
            "unknown_sightings": sum(
                1 for track in tracks if track["identity"] == "unknown"
            ),
            "combat_active": bool(combat_active),
            "moved_entities": sorted(
                track["ref"] for track in tracks if track["movement"] is not None
            ),
            "reappeared_entities": sorted(
                track["ref"] for track in tracks if track["status"] == "reappeared"
            ),
            "occluded_entities": sorted(
                track["ref"] for track in tracks if track["status"] == "occluded"
            ),
        },
    }
    return validate_gameplay(document)


def validate_gameplay(data: dict) -> dict:
    """Strictly validate a gameplay-v1 document; reject anything else."""
    if not isinstance(data, dict):
        raise ObservationError("Gameplay state must be a JSON object.")
    _reject_extra(
        data,
        ("schema_version", "latest_timestamp", "fact_signals", "entities", "summary"),
        "Gameplay state",
    )
    if data.get("schema_version") != GAMEPLAY_SCHEMA_VERSION:
        raise ObservationError(
            f"Gameplay state requires schema_version '{GAMEPLAY_SCHEMA_VERSION}'."
        )
    latest = data.get("latest_timestamp")
    if latest is not None and (
        isinstance(latest, bool) or not isinstance(latest, (int, float))
    ):
        raise ObservationError(
            "Gameplay state field 'latest_timestamp' must be a number or null."
        )
    if "fact_signals" not in data or not isinstance(data["fact_signals"], list):
        raise ObservationError(
            "Gameplay state requires field 'fact_signals' as a list."
        )
    for index, item in enumerate(data["fact_signals"]):
        where = f"fact_signals[{index}]"
        if not isinstance(item, dict):
            raise ObservationError(f"{where} must be an object.")
        _reject_extra(
            item,
            ("category", "description", "observed", "inferred", "entities"),
            where,
        )
        _require_non_empty_string(item, "category", where)
        _require_non_empty_string(item, "description", where)
        for field in ("observed", "inferred"):
            values = item.get(field)
            if not isinstance(values, list) or any(
                not isinstance(tag, str) or not tag.strip() for tag in values
            ):
                raise ObservationError(
                    f"{where} requires '{field}' as a list of non-empty strings."
                )
        entities = item.get("entities")
        if not isinstance(entities, list) or any(
            not isinstance(entity, dict) for entity in entities
        ):
            raise ObservationError(
                f"{where} requires 'entities' as a list of objects."
            )
        for entity_index, entity in enumerate(entities):
            entity_where = f"{where}.entities[{entity_index}]"
            _reject_extra(entity, ("label", "kind"), entity_where)
            _require_non_empty_string(entity, "label", entity_where)
            _require_non_empty_string(entity, "kind", entity_where)
    if "entities" not in data or not isinstance(data["entities"], list):
        raise ObservationError("Gameplay state requires field 'entities' as a list.")
    for index, track in enumerate(data["entities"]):
        where = f"entities[{index}]"
        if not isinstance(track, dict):
            raise ObservationError(f"{where} must be an object.")
        _reject_extra(
            track,
            (
                "ref",
                "kind",
                "identity",
                "first_seen",
                "last_seen",
                "status",
                "posture",
                "movement",
                "sightings",
            ),
            where,
        )
        _require_non_empty_string(track, "ref", where)
        _require_non_empty_string(track, "kind", where)
        if track.get("identity") not in ("exact-label", "unknown"):
            raise ObservationError(f"{where} has invalid identity.")
        for seen_field in ("first_seen", "last_seen"):
            seen = track.get(seen_field)
            if isinstance(seen, bool) or not isinstance(seen, (int, float)):
                raise ObservationError(
                    f"{where} field '{seen_field}' must be a number."
                )
        if track.get("status") not in ("observed", "reappeared", "occluded"):
            raise ObservationError(f"{where} has invalid status.")
        posture = track.get("posture")
        if posture is not None and (not isinstance(posture, str) or not posture):
            raise ObservationError(f"{where} field 'posture' must be a string or null.")
        movement = track.get("movement")
        if movement is not None:
            if not isinstance(movement, dict):
                raise ObservationError(
                    f"{where} field 'movement' must be an object or null."
                )
            _reject_extra(movement, ("from", "to"), f"{where}.movement")
            _require_non_empty_string(movement, "from", f"{where}.movement")
            _require_non_empty_string(movement, "to", f"{where}.movement")
        sightings = track.get("sightings")
        if not isinstance(sightings, list) or not sightings:
            raise ObservationError(
                f"{where} requires 'sightings' as a non-empty list."
            )
        for sighting_index, sighting in enumerate(sightings):
            sighting_where = f"{where}.sightings[{sighting_index}]"
            if not isinstance(sighting, dict):
                raise ObservationError(f"{sighting_where} must be an object.")
            _reject_extra(
                sighting,
                (
                    "timestamp",
                    "source",
                    "fact_key",
                    "spatial",
                    "action",
                    "posture",
                    "observed",
                ),
                sighting_where,
            )
            timestamp = sighting.get("timestamp")
            if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)):
                raise ObservationError(
                    f"{sighting_where} field 'timestamp' must be a number."
                )
            _require_non_empty_string(sighting, "source", sighting_where)
    summary = data.get("summary")
    if not isinstance(summary, dict):
        raise ObservationError("Gameplay state requires field 'summary' as an object.")
    _reject_extra(
        summary,
        (
            "entity_count",
            "unknown_sightings",
            "combat_active",
            "moved_entities",
            "reappeared_entities",
            "occluded_entities",
        ),
        "Gameplay state summary",
    )
    return data


def fact_signal_tags(gameplay: dict, category: str, description: str) -> dict:
    """Return merged ``{"observed", "inferred", "entities"}`` for one fact key.

    Unknown keys yield empty tags (never an error), so callers stay total
    over facts the gameplay document never saw.
    """
    wanted = fact_key(category, description)
    for item in gameplay.get("fact_signals", []):
        if (item["category"], item["description"]) == wanted:
            return {
                "observed": list(item["observed"]),
                "inferred": list(item["inferred"]),
                "entities": list(item["entities"]),
            }
    return {"observed": [], "inferred": [], "entities": []}


def entity_track_for_label(gameplay: dict, label: str) -> dict | None:
    """Return the entity track for one exact label, or None."""
    for track in gameplay.get("entities", []):
        if track["ref"] == label and track["identity"] == "exact-label":
            return track
    return None
