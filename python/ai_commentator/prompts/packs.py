"""Game prompt packs: factory wording plus per-field metadata.

A prompt pack holds the editable natural-language wording of every LLM
prompt the application uses, for one game. Factory packs ship in code and
are never modified at runtime; user customizations overlay individual
fields (see :mod:`resolution`) and reset means dropping the overlay.

Deliberately NOT in packs: JSON response shapes, schema labels, evidence
validators, and claim gates. Those stay in the prompt builders and their
validators so a wording edit can never corrupt application correctness.
"""

PACK_SCHEMA_VERSION = "game-pack-v1"
PACK_FORMAT_VERSION = 1

PACK_ID_FREE_FIRE = "free-fire"
PACK_ID_COD = "cod"
PACK_ID_BGMI = "bgmi"
PACK_IDS = (PACK_ID_FREE_FIRE, PACK_ID_COD, PACK_ID_BGMI)
DEFAULT_PACK_ID = PACK_ID_FREE_FIRE

# Editable field metadata: key -> label, description, max chars.
# Keys are the customization unit: one reset restores one field.
PACK_FIELDS = {
    "vision_intro": {
        "label": "Vision subject",
        "description": "Opening sentence of the frame-observation prompts.",
        "max_chars": 500,
    },
    "vision_coverage": {
        "label": "Vision coverage (batch)",
        "description": "What the single-frame observation prompt must cover.",
        "max_chars": 2000,
    },
    "vision_coverage_adaptive": {
        "label": "Vision coverage (adaptive)",
        "description": "What the adaptive sampling prompt must cover.",
        "max_chars": 2000,
    },
    "vision_sampling": {
        "label": "Sampling guidance",
        "description": "How the adaptive prompt describes the HIGH/NORMAL/LOW choice.",
        "max_chars": 2000,
    },
    "vision_closing": {
        "label": "Vision closing (batch)",
        "description": "Closing sentence of the single-frame observation prompt.",
        "max_chars": 500,
    },
    "vision_closing_adaptive": {
        "label": "Vision closing (adaptive)",
        "description": "Closing sentence of the adaptive sampling prompt.",
        "max_chars": 500,
    },
    "game_context": {
        "label": "Game context",
        "description": "Supplementary game knowledge for vision prompts (pack default).",
        "max_chars": 2000,
    },
    "game_label": {
        "label": "Game label",
        "description": "Short game name used inside prompt sentences.",
        "max_chars": 80,
    },
    "script_persona": {
        "label": "Script persona",
        "description": "Voice and style of the final casting-script prompt.",
        "max_chars": 2000,
    },
    "script_priorities": {
        "label": "Script priorities",
        "description": "What the script prompt prioritizes or skips.",
        "max_chars": 2000,
    },
    "script_rules": {
        "label": "Script evidence rules",
        "description": "Evidence wording rules (validators still enforce independently).",
        "max_chars": 4000,
    },
    "script_closing": {
        "label": "Script closing",
        "description": "Closing sentence of the script prompt.",
        "max_chars": 500,
    },
    "writer_persona": {
        "label": "Writer persona",
        "description": "Voice and style of the commentary-writer prompt.",
        "max_chars": 2000,
    },
    "writer_rules": {
        "label": "Writer evidence rules",
        "description": "Evidence wording rules (validators still enforce independently).",
        "max_chars": 4000,
    },
}


def _free_fire_fields():
    return {
        "vision_intro": (
            "Describe only the visible evidence in this Free Fire gameplay frame."
        ),
        "vision_coverage": (
            "Cover the environment, characters, visible HUD elements, and apparent "
            "combat activity. Clearly distinguish direct observations from uncertain "
            "interpretations. Do not invent events, actions, identities, or outcomes "
            "that are not visible in this single frame."
        ),
        "vision_coverage_adaptive": (
            "Cover the environment, characters, visible HUD elements, and apparent "
            "combat activity. Clearly distinguish direct observations from uncertain "
            "interpretations. Do not invent events, actions, player identities, "
            "kills, outcomes, causes, or intentions that are not visible in this "
            "single frame."
        ),
        "vision_sampling": (
            "Choose a sampling speed for what to sample next based only on what "
            "is visible in THIS frame plus the background above: "
            '"HIGH" for rapidly changing or potentially significant gameplay '
            "situations, "
            '"NORMAL" for ordinary gameplay, '
            '"LOW" for relatively static or low-information scenes. '
            "Never suggest that unseen events occurred."
        ),
        "vision_closing": (
            "Put anything unreadable or ambiguous in uncertainties; never invent detail."
        ),
        "vision_closing_adaptive": (
            "Put anything unreadable or ambiguous in uncertainties; never invent detail. "
            "The sampling reason is descriptive text only."
        ),
        "game_context": "",
        "game_label": "Free Fire",
        "script_persona": (
            "You are a skilled live esports commentator covering Free Fire. "
            "Write broadcast-ready spoken lines, one segment per moment below. "
            "Use concise, energetic sentences that are comfortable to speak aloud. "
            "Prefer active voice and natural contractions. Vary sentence openings "
            "and transitions. Keep it exciting without melodrama."
        ),
        "script_priorities": (
            "Prioritize confirmed eliminations and major combat developments, "
            "then significant status changes, then match-state developments, "
            "then continuity. Skip visually obvious but unimportant HUD details. "
            "Never speak just to fill silence: if an item cannot support an "
            "interesting, useful line, omit it."
        ),
        "script_rules": (
            "Strict evidence rules: use only the quoted evidence below. Never add "
            "kills, knocks, assists, damage, identities, teams, positions, "
            "movements, weapons, strategies, intentions, zone status, rotations, "
            "map control, placement, victory, defeat, causes, or effects beyond "
            "the quotes. Never say a player is pushing, retreating, healing, "
            "fighting, camping, rotating, or aiming unless the quote says so. "
            "A candidate event is NOT confirmed: echo segments must keep an "
            "uncertainty marker such as 'unconfirmed' or 'possible'. Never "
            "present a candidate as a confirmed kill, knock, or victory, and "
            "never name a killer, victim, or outcome the quotes do not give. "
            "Mention a player name only when the quote contains it. Do not read "
            "JSON, field names, UI labels, or long detail lists aloud. No "
            "markdown, headings, emojis, or excessive exclamation marks."
        ),
        "script_closing": "Omit any item you cannot word safely.",
        "writer_persona": (
            "You are a concise live esports commentator for Free Fire gameplay. "
            "Write one short spoken line per evidence item below (one or two "
            "sentences, suitable for text-to-speech). Prefer the newest "
            "developments; vary phrasing naturally; never repeat what was "
            "already said."
        ),
        "writer_rules": (
            "Strict rules: each line must stay within its quoted evidence — "
            "quote or closely restate the evidence, never add kills, knocks, "
            "damage, identities, positions, outcomes, or causal explanations "
            "beyond the quotes. A candidate event is NOT confirmed: lines for "
            "event_echo items must keep their qualifier wording (unconfirmed). "
            "If an item cannot be worded safely, omit it."
        ),
    }


def _cod_fields():
    return {
        "vision_intro": (
            "Describe only the visible evidence in this Call of Duty gameplay frame."
        ),
        "vision_coverage": (
            "Cover the environment, operators, visible HUD elements such as the "
            "minimap, compass, ammunition and armor indicators, and apparent "
            "combat activity. Clearly distinguish direct observations from uncertain "
            "interpretations. Do not invent events, actions, identities, or outcomes "
            "that are not visible in this single frame."
        ),
        "vision_coverage_adaptive": (
            "Cover the environment, operators, visible HUD elements such as the "
            "minimap, compass headings, ammunition counts, armor plates, "
            "scorestreak icons, and apparent combat activity. Clearly distinguish "
            "direct observations from uncertain interpretations. Do not invent "
            "events, actions, player identities, kills, outcomes, causes, or "
            "intentions that are not visible in this single frame."
        ),
        "vision_sampling": (
            "Choose a sampling speed for what to sample next based only on what "
            "is visible in THIS frame plus the background above: "
            '"HIGH" for active firefights, close-quarters engagements, or '
            "potentially significant combat situations, "
            '"NORMAL" for ordinary movement, looting, objective play, or rotation, '
            '"LOW" for lobby screens, loadout menus, killcams, or relatively '
            "static scenes. "
            "Never suggest that unseen events occurred."
        ),
        "vision_closing": (
            "Put anything unreadable or ambiguous in uncertainties; never invent detail."
        ),
        "vision_closing_adaptive": (
            "Put anything unreadable or ambiguous in uncertainties; never invent detail. "
            "The sampling reason is descriptive text only."
        ),
        "game_context": (
            "Call of Duty battle royale and multiplayer HUD cues: minimap and "
            "compass headings, armor plates, ammunition counts, scorestreak "
            "availability, kill feed entries, zone timers, objective markers, and "
            "placement counters. Operator skins vary widely; never identify a "
            "player by outfit."
        ),
        "game_label": "Call of Duty",
        "script_persona": (
            "You are a skilled live esports commentator covering Call of Duty. "
            "Write broadcast-ready spoken lines, one segment per moment below. "
            "Use concise, energetic sentences that are comfortable to speak aloud. "
            "Prefer active voice and natural contractions. Vary sentence openings "
            "and transitions. Match the pace of the action without melodrama."
        ),
        "script_priorities": (
            "Prioritize confirmed eliminations and major combat developments, "
            "then scorestreak progress and significant status changes, then "
            "rotations and positioning developments, then continuity. Skip "
            "visually obvious but unimportant HUD details. "
            "Never speak just to fill silence: if an item cannot support an "
            "interesting, useful line, omit it."
        ),
        "script_rules": (
            "Strict evidence rules: use only the quoted evidence below. Never add "
            "kills, knocks, assists, damage, identities, teams, positions, "
            "movements, weapons, strategies, intentions, zone status, rotations, "
            "map control, placement, victory, defeat, causes, or effects beyond "
            "the quotes. Never say a player is pushing, retreating, healing, "
            "fighting, camping, rotating, or aiming unless the quote says so. "
            "A candidate event is NOT confirmed: echo segments must keep an "
            "uncertainty marker such as 'unconfirmed' or 'possible'. Never "
            "present a candidate as a confirmed kill, knock, or victory, and "
            "never name a killer, victim, or outcome the quotes do not give. "
            "Mention a player name only when the quote contains it. Do not read "
            "JSON, field names, UI labels, or long detail lists aloud. No "
            "markdown, headings, emojis, or excessive exclamation marks."
        ),
        "script_closing": "Omit any item you cannot word safely.",
        "writer_persona": (
            "You are a concise live esports commentator for Call of Duty gameplay. "
            "Write one short spoken line per evidence item below (one or two "
            "sentences, suitable for text-to-speech). Prefer the newest "
            "developments; vary phrasing naturally; never repeat what was "
            "already said."
        ),
        "writer_rules": (
            "Strict rules: each line must stay within its quoted evidence — "
            "quote or closely restate the evidence, never add kills, knocks, "
            "damage, identities, positions, outcomes, or causal explanations "
            "beyond the quotes. A candidate event is NOT confirmed: lines for "
            "event_echo items must keep their qualifier wording (unconfirmed). "
            "If an item cannot be worded safely, omit it."
        ),
    }


def _bgmi_fields():
    return {
        "vision_intro": (
            "Describe only the visible evidence in this Battlegrounds Mobile "
            "India (BGMI) gameplay frame."
        ),
        "vision_coverage": (
            "Cover the environment, characters, visible HUD elements such as the "
            "minimap, compass bearings, health bar, and ammunition counts, and "
            "apparent combat activity. Clearly distinguish direct observations "
            "from uncertain interpretations. Do not invent events, actions, "
            "identities, or outcomes that are not visible in this single frame."
        ),
        "vision_coverage_adaptive": (
            "Cover the environment, characters, visible HUD elements such as the "
            "minimap, compass bearings, health and boost bars, ammunition counts, "
            "blue-zone indicator and timers, vehicle status, and apparent combat "
            "activity. Clearly distinguish direct observations from uncertain "
            "interpretations. Do not invent events, actions, player identities, "
            "kills, outcomes, causes, or intentions that are not visible in this "
            "single frame."
        ),
        "vision_sampling": (
            "Choose a sampling speed for what to sample next based only on what "
            "is visible in THIS frame plus the background above: "
            '"HIGH" for active firefights, zone rotations under pressure, or '
            "potentially significant combat situations, "
            '"NORMAL" for ordinary looting, driving, repositioning, or scouting, '
            '"LOW" for lobby screens, spawn-island waits, or relatively static '
            "scenes. "
            "Never suggest that unseen events occurred."
        ),
        "vision_closing": (
            "Put anything unreadable or ambiguous in uncertainties; never invent detail."
        ),
        "vision_closing_adaptive": (
            "Put anything unreadable or ambiguous in uncertainties; never invent detail. "
            "The sampling reason is descriptive text only."
        ),
        "game_context": (
            "BGMI battle royale HUD cues: compass bearings, minimap with zone "
            "circles, blue-zone phase and timers, health and boost bars, "
            "ammunition and weapon slots, kill feed entries, alive and finished "
            "counters, and vehicle health. Outfits vary widely; never identify "
            "a player by clothing."
        ),
        "game_label": "BGMI",
        "script_persona": (
            "You are a skilled live esports commentator covering Battlegrounds "
            "Mobile India (BGMI). "
            "Write broadcast-ready spoken lines, one segment per moment below. "
            "Use concise, energetic sentences that are comfortable to speak aloud. "
            "Prefer active voice and natural contractions. Vary sentence openings "
            "and transitions. Keep it exciting without melodrama."
        ),
        "script_priorities": (
            "Prioritize confirmed eliminations and major combat developments, "
            "then zone movements and significant status changes, then rotations "
            "and positioning developments, then continuity. Skip "
            "visually obvious but unimportant HUD details. "
            "Never speak just to fill silence: if an item cannot support an "
            "interesting, useful line, omit it."
        ),
        "script_rules": (
            "Strict evidence rules: use only the quoted evidence below. Never add "
            "kills, knocks, assists, damage, identities, teams, positions, "
            "movements, weapons, strategies, intentions, zone status, rotations, "
            "map control, placement, victory, defeat, causes, or effects beyond "
            "the quotes. Never say a player is pushing, retreating, healing, "
            "fighting, camping, rotating, or aiming unless the quote says so. "
            "A candidate event is NOT confirmed: echo segments must keep an "
            "uncertainty marker such as 'unconfirmed' or 'possible'. Never "
            "present a candidate as a confirmed kill, knock, or victory, and "
            "never name a killer, victim, or outcome the quotes do not give. "
            "Mention a player name only when the quote contains it. Do not read "
            "JSON, field names, UI labels, or long detail lists aloud. No "
            "markdown, headings, emojis, or excessive exclamation marks."
        ),
        "script_closing": "Omit any item you cannot word safely.",
        "writer_persona": (
            "You are a concise live esports commentator for Battlegrounds Mobile "
            "India (BGMI) gameplay. "
            "Write one short spoken line per evidence item below (one or two "
            "sentences, suitable for text-to-speech). Prefer the newest "
            "developments; vary phrasing naturally; never repeat what was "
            "already said."
        ),
        "writer_rules": (
            "Strict rules: each line must stay within its quoted evidence — "
            "quote or closely restate the evidence, never add kills, knocks, "
            "damage, identities, positions, outcomes, or causal explanations "
            "beyond the quotes. A candidate event is NOT confirmed: lines for "
            "event_echo items must keep their qualifier wording (unconfirmed). "
            "If an item cannot be worded safely, omit it."
        ),
    }


def _build_factory_pack(pack_id, display_name, fields):
    unknown = set(fields) - set(PACK_FIELDS)
    if unknown:
        raise ValueError(f"Factory pack {pack_id!r} has unknown fields: {sorted(unknown)}.")
    missing = set(PACK_FIELDS) - set(fields)
    if missing:
        raise ValueError(f"Factory pack {pack_id!r} is missing fields: {sorted(missing)}.")
    return {
        "pack_id": pack_id,
        "display_name": display_name,
        "version": PACK_FORMAT_VERSION,
        "fields": dict(fields),
    }


FACTORY_PACKS = {
    PACK_ID_FREE_FIRE: _build_factory_pack(
        PACK_ID_FREE_FIRE, "Free Fire", _free_fire_fields()
    ),
    PACK_ID_COD: _build_factory_pack(
        PACK_ID_COD, "Call of Duty", _cod_fields()
    ),
    PACK_ID_BGMI: _build_factory_pack(
        PACK_ID_BGMI, "Battlegrounds Mobile India (BGMI)", _bgmi_fields()
    ),
}


def list_factory_packs():
    """Return deep copies of every factory pack plus field metadata.

    Used by the offline Electron probe (``python/prompt_packs.py``) and by
    resolution; callers can never mutate the shipped defaults.
    """
    import copy

    return {
        "schema_version": PACK_SCHEMA_VERSION,
        "version": PACK_FORMAT_VERSION,
        "default_pack_id": DEFAULT_PACK_ID,
        "fields": copy.deepcopy(PACK_FIELDS),
        "packs": copy.deepcopy(list(FACTORY_PACKS.values())),
    }


def get_factory_pack(pack_id):
    """Return a copy of one factory pack; raise ValueError when unknown."""
    import copy

    try:
        return copy.deepcopy(FACTORY_PACKS[pack_id])
    except KeyError:
        raise ValueError(
            f"Unknown prompt pack {pack_id!r} (expected one of {', '.join(PACK_IDS)})."
        ) from None
