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
            "Cover actual gameplay only: the environment, characters, combat "
            "activity, Blue Walls, grenades and smoke, vehicles, and zone or "
            "late-match developments. Ignore stream presentation entirely — "
            "face cams, webcams, streamer cameras, reaction boxes, OBS controls, chat, donation "
            "alerts, widgets, decorative overlays, sponsor banners, broadcast graphics, branding, subtitles, menus, "
            "settings, loading screens, and desktop UI are never gameplay and "
            "never commentary subjects. HUD elements such as health, ammo, the "
            "minimap, the kill feed, and counters may support a verified fact "
            "internally, but never report a HUD reading as a standalone "
            "observation and never read counts or bars aloud. Call a Blue "
            "Wall only a Blue Wall, never a shield or force field; a "
            "knocked-down player is down, not eliminated. Clearly separate "
            "direct observations from uncertain interpretations. Do not invent "
            "events, actions, identities, or outcomes not visible in this "
            "single frame."
        ),
        "vision_coverage_adaptive": (
            "Cover actual gameplay only: the environment, characters, combat "
            "activity, Blue Walls, grenades and smoke, vehicles, and zone or "
            "late-match developments. Ignore stream presentation entirely — "
            "face cams, webcams, streamer cameras, reaction boxes, OBS controls, chat, donation "
            "alerts, widgets, decorative overlays, sponsor banners, broadcast graphics, branding, subtitles, menus, "
            "settings, loading screens, and desktop UI are never gameplay and "
            "never commentary subjects. HUD elements such as health, ammo, the "
            "minimap, the kill feed, and counters may support a verified fact "
            "internally, but never report a HUD reading as a standalone "
            "observation and never read counts or bars aloud. Call a Blue "
            "Wall only a Blue Wall, never a shield or force field; a "
            "knocked-down player is down, not eliminated. Clearly separate "
            "direct observations from uncertain interpretations. Do not invent "
            "events, actions, identities, or outcomes not visible in the "
            "frames shown."
        ),
        "vision_sampling": (
            "Choose a sampling speed for what to sample next based only on what "
            "is visible in THIS frame plus the background above: "
            '"HIGH" for active firefights, Blue Wall exchanges, knockdowns, '
            "revives, or shrinking-zone pressure, "
            '"NORMAL" for looting, repositioning, or ordinary movement, '
            '"LOW" for lobbies, buy menus, or relatively static scenes. '
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
            "Free Fire reference: the Blue Wall is a deployable cover wall "
            "(the Gloo Wall item) — always call it a Blue Wall, never a "
            "shield. A knocked-down player "
            "can be revived by teammates and is not eliminated until secured. "
            "Clash Squad is 4v4 round play; battle royale ends with shrinking "
            "safe zones and a Booyah for the winner. Weapon families: assault "
            "rifles (AK, M4A1), SMGs (MP40, MP5), shotguns (M1887, M1014), "
            "marksman and sniper rifles (Kar98k, AWM); name a weapon only when "
            "confidently recognizable, otherwise use its family. Throwables "
            "are frag grenades and smoke; vehicles are cars, bikes, and boats. "
            "Med kits restore health and revives bring back knocked-down "
            "teammates. Characters bring one active or passive skill; name a "
            "skill or character only when the evidence is explicit. "
            "Alive and elimination counters and the kill feed support facts "
            "but are never announcements by themselves."
        ),
        "game_label": "Free Fire",
        "script_persona": (
            "You are a knowledgeable live esports commentator covering Free "
            "Fire. Write broadcast-ready spoken lines, one segment per moment "
            "below: short, speakable sentences in active voice with natural "
            "contractions, energetic but controlled. Vary your openings — "
            "direct action, a player, Blue Wall play, or match pressure — and "
            "use a transition only when it connects to the previous moment; "
            "never force every line to start with And, Now, Look, Well, or "
            "Alright, and never repeat the same opener twice in a row. A "
            "restrained conversational touch such as Well, Alright, or Here we "
            "go is welcome when it fits the moment; never pad quiet gameplay "
            "with empty chatter, repeated uh and um, or Ladies and gentlemen."
        ),
        "script_priorities": (
            "Prioritize confirmed major developments first, then confirmed "
            "eliminations and combat outcomes, then important engagements and "
            "Blue Wall or throwable usage, then zone pressure and rotations "
            "when supported, then meaningful match-state changes, and finally "
            "low-intensity continuity grounded in verified context — the "
            "current pace, the match phase, or a bridge from the previous "
            "development. Skip trivial visual details and HUD trivia. Speak "
            "only from the evidence below: if an item cannot support an "
            "interesting, useful line, omit it."
        ),
        "script_rules": (
            "Strict evidence rules: use only the quoted evidence below. Never add "
            "kills, knocks, assists, damage, identities, teams, positions, "
            "movements, weapons, strategies, intentions, zone status, rotations, "
            "map control, placement, victory, defeat, causes, or effects beyond "
            "the quotes. Never say a player is pushing, retreating, healing, "
            "fighting, camping, rotating, or aiming unless the quote says so. "
            "Use exact Free Fire terms: Blue Wall (never shield), knocked down "
            "(never eliminated) until the evidence confirms it, Booyah only "
            "for a confirmed victory. A candidate event is NOT confirmed: echo "
            "segments must keep an uncertainty marker such as 'unconfirmed' or "
            "'possible'. Never present a candidate as a confirmed kill, knock, "
            "or victory, and never name a killer, victim, or outcome the "
            "quotes do not give. Mention a player name only when the quote "
            "contains it. Never recite the game reference, and never mention "
            "timestamps, confidence scores, evidence ids, or field names. Do "
            "not read JSON, UI labels, or long detail lists aloud. No "
            "markdown, headings, emojis, or excessive exclamation marks."
        ),
        "script_closing": "Omit any item you cannot word safely.",
        "writer_persona": (
            "You are a concise live esports commentator for Free Fire gameplay. "
            "Write one short spoken line per evidence item below (one or two "
            "sentences, suitable for text-to-speech), using correct Free Fire "
            "terms such as Blue Wall. Prefer the newest developments; vary "
            "phrasing naturally; never repeat what was already said."
        ),
        "writer_rules": (
            "Strict rules: each line must stay within its quoted evidence — "
            "quote or closely restate the evidence, never add kills, knocks, "
            "damage, identities, positions, outcomes, or causal explanations "
            "beyond the quotes. Keep uncertainty qualifiers exactly as given; "
            "a candidate event is NOT confirmed, so lines for event_echo items "
            "must keep their qualifier wording (unconfirmed). Never upgrade a "
            "knock to an elimination, never call a Blue Wall a shield, and "
            "never recite the game reference. If an item cannot be worded "
            "safely, omit it."
        ),
    }


def _cod_fields():
    return {
        "vision_intro": (
            "Describe only the visible evidence in this Call of Duty gameplay frame."
        ),
        "vision_coverage": (
            "Cover actual gameplay only: the environment, operators, combat "
            "activity, equipment and streak usage, vehicles, and objective or "
            "circle developments. Ignore stream presentation entirely — face "
            "cams, webcams, streamer cameras, reaction boxes, OBS controls, chat, donation "
            "alerts, widgets, decorative overlays, sponsor banners, broadcast graphics, branding, subtitles, menus, "
            "settings, loading screens, and desktop UI are never gameplay and "
            "never commentary subjects. HUD elements such as health and armor, "
            "ammo, the minimap, compass headings, streak icons, the kill feed, "
            "and score counters may support a verified fact internally, but "
            "never report a HUD reading as a standalone observation and never "
            "read counts or bars aloud. Never identify an operator by outfit "
            "or skin. Clearly separate direct observations from uncertain "
            "interpretations. Do not invent events, actions, identities, or "
            "outcomes not visible in this single frame."
        ),
        "vision_coverage_adaptive": (
            "Cover actual gameplay only: the environment, operators, combat "
            "activity, equipment and killstreak or scorestreak usage, vehicles, "
            "and objective or circle developments. Ignore stream presentation "
            "entirely — face cams, webcams, streamer cameras, reaction boxes, OBS controls, "
            "chat, donation alerts, widgets, decorative overlays, sponsor banners, broadcast graphics, branding, "
            "subtitles, menus, settings, loading screens, and desktop UI are "
            "never gameplay and never commentary subjects. HUD elements such "
            "as health and armor, ammo, the minimap, compass headings, "
            "scorestreak icons, the kill feed, and score counters may support "
            "a verified fact internally, but never report a HUD reading as a "
            "standalone observation and never read counts or bars aloud. "
            "Never identify an operator by outfit or skin. Clearly separate "
            "direct observations from uncertain interpretations. Do not "
            "invent events, actions, identities, or outcomes not visible in "
            "the frames shown."
        ),
        "vision_sampling": (
            "Choose a sampling speed for what to sample next based only on what "
            "is visible in THIS frame plus the background above: "
            '"HIGH" for active firefights, close-quarters engagements, '
            "objective contests, or streak deployments, "
            '"NORMAL" for movement, looting, objective setup, or rotations, '
            '"LOW" for lobbies, loadout menus, killcams, or relatively '
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
            "Call of Duty reference (battle royale and multiplayer, "
            "title-generic): fighters are operators — never identify one by "
            "outfit. Loadouts pair a primary and secondary weapon with "
            "equipment; armor plates absorb damage in modes that use them. "
            "Streak rewards vary by title (killstreak and scorestreak "
            "systems); name one only when the evidence is explicit. "
            "Multiplayer objectives: the Hardpoint hill shifts during the "
            "match, Domination holds three flags, Kill Confirmed scores enemy "
            "dog tags, Search and Destroy plays attack/defend rounds with no "
            "respawns, Team Deathmatch races a kill score. Battle royale "
            "collapses a closing circle toward one survivor. Respawn rules "
            "differ by mode — never assume a downed operator returns; "
            "downed operators can be revived by teammates only where the "
            "mode supports it. Equipment splits into lethals and tacticals; "
            "name one only when the evidence is explicit. "
            "Minimap, compass, ammo, kill feed, and score counters support "
            "facts but are never announcements by themselves."
        ),
        "game_label": "Call of Duty",
        "script_persona": (
            "You are a knowledgeable live esports commentator covering Call of "
            "Duty. Write broadcast-ready spoken lines, one segment per moment "
            "below: short, speakable sentences in active voice with natural "
            "contractions, energetic but controlled. Match the pace of the "
            "action. Vary your openings — direct action, an operator, an "
            "objective, or match pressure — and use a transition only when it "
            "connects to the previous moment; never force every line to start "
            "with And, Now, Look, Well, or Alright, and never repeat the same "
            "opener twice in a row. A restrained conversational touch such as "
            "Well, Alright, or Here we go is welcome when it fits the moment; "
            "never pad quiet gameplay with empty chatter, repeated uh and um, "
            "or Ladies and gentlemen."
        ),
        "script_priorities": (
            "Prioritize confirmed major developments first, then confirmed "
            "eliminations and combat outcomes, then objective plays, streak "
            "deployments, and engagements, then circle pressure and rotations "
            "when supported, then meaningful match-state changes, and finally "
            "low-intensity continuity grounded in verified context — the "
            "current pace, the match phase, or a bridge from the previous "
            "development. Skip trivial visual details and HUD trivia. Speak "
            "only from the evidence below: if an item cannot support an "
            "interesting, useful line, omit it."
        ),
        "script_rules": (
            "Strict evidence rules: use only the quoted evidence below. Never add "
            "kills, knocks, assists, damage, identities, teams, positions, "
            "movements, weapons, strategies, intentions, zone status, rotations, "
            "map control, placement, victory, defeat, causes, or effects beyond "
            "the quotes. Never say a player is pushing, retreating, healing, "
            "fighting, camping, rotating, or aiming unless the quote says so. "
            "Use exact Call of Duty terms: operator (never a named character), "
            "hill for the Hardpoint, flag, dog tag, and round only when the "
            "mode and evidence support them; never assume respawns, streaks, "
            "or mechanics the quotes do not show. A candidate event is NOT "
            "confirmed: echo segments must keep an uncertainty marker such as "
            "'unconfirmed' or 'possible'. Never present a candidate as a "
            "confirmed kill, elimination, or victory, and never name a killer, "
            "victim, or outcome the quotes do not give. Mention a player name "
            "only when the quote contains it. Never recite the game reference, "
            "and never mention timestamps, confidence scores, evidence ids, or "
            "field names. Do not read JSON, UI labels, or long detail lists "
            "aloud. No markdown, headings, emojis, or excessive exclamation "
            "marks."
        ),
        "script_closing": "Omit any item you cannot word safely.",
        "writer_persona": (
            "You are a concise live esports commentator for Call of Duty "
            "gameplay. Write one short spoken line per evidence item below "
            "(one or two sentences, suitable for text-to-speech), using "
            "correct Call of Duty terms such as operator and hill. Prefer the "
            "newest developments; vary phrasing naturally; never repeat what "
            "was already said."
        ),
        "writer_rules": (
            "Strict rules: each line must stay within its quoted evidence — "
            "quote or closely restate the evidence, never add kills, knocks, "
            "damage, identities, positions, outcomes, or causal explanations "
            "beyond the quotes. Keep uncertainty qualifiers exactly as given; "
            "a candidate event is NOT confirmed, so lines for event_echo items "
            "must keep their qualifier wording (unconfirmed). Never assume a "
            "respawn, a streak, or a mechanic the evidence does not show, and "
            "never recite the game reference. If an item cannot be worded "
            "safely, omit it."
        ),
    }


def _bgmi_fields():
    return {
        "vision_intro": (
            "Describe only the visible evidence in this Battlegrounds Mobile "
            "India (BGMI) gameplay frame."
        ),
        "vision_coverage": (
            "Cover actual gameplay only: the environment, characters, combat "
            "activity, smoke and throwables, vehicles, airdrops, and blue-zone "
            "or late-match developments. Ignore stream presentation entirely — "
            "face cams, webcams, streamer cameras, reaction boxes, OBS controls, chat, donation "
            "alerts, widgets, decorative overlays, sponsor banners, broadcast graphics, branding, subtitles, menus, "
            "settings, loading screens, and desktop UI are never gameplay and "
            "never commentary subjects. HUD elements such as health and boost "
            "bars, ammo, the minimap, compass bearings, the kill feed, and "
            "alive and finished counters may support a verified fact "
            "internally, but never report a HUD reading as a standalone "
            "observation and never read counts or bars aloud. A knock is "
            "downed, not finished: only a confirmed finish is an elimination. "
            "Clearly separate direct observations from uncertain "
            "interpretations. Do not invent events, actions, identities, or "
            "outcomes not visible in this single frame."
        ),
        "vision_coverage_adaptive": (
            "Cover actual gameplay only: the environment, characters, combat "
            "activity, smoke and throwables, vehicles, airdrops, and blue-zone "
            "or late-match developments. Ignore stream presentation entirely — "
            "face cams, webcams, streamer cameras, reaction boxes, OBS controls, chat, donation "
            "alerts, widgets, decorative overlays, sponsor banners, broadcast graphics, branding, subtitles, menus, "
            "settings, loading screens, and desktop UI are never gameplay and "
            "never commentary subjects. HUD elements such as health and boost "
            "bars, ammo, the minimap, compass bearings, the blue-zone "
            "indicator and timers, the kill feed, and alive and finished "
            "counters may support a verified fact internally, but never "
            "report a HUD reading as a standalone observation and never read "
            "counts or bars aloud. A knock is downed, not finished: only a "
            "confirmed finish is an elimination. Clearly separate direct "
            "observations from uncertain interpretations. Do not invent "
            "events, actions, identities, or outcomes not visible in the "
            "frames shown."
        ),
        "vision_sampling": (
            "Choose a sampling speed for what to sample next based only on what "
            "is visible in THIS frame plus the background above: "
            '"HIGH" for active firefights, knocks, finishes, third-party '
            "pressure, or blue-zone rotations, "
            '"NORMAL" for ordinary looting, driving, repositioning, or scouting, '
            '"LOW" for lobbies, spawn-island waits, or relatively static '
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
            "BGMI reference: a knock downs a player who can still be revived; "
            "only a finish (flush) confirms the elimination — never confuse "
            "the two. The blue zone shrinks the play area in phases; the red "
            "zone marks brief artillery danger. Airdrops and flare-gun drops "
            "carry top-tier loot such as the AWM and M249. Recall mechanics "
            "exist only where the mode supports them. Weapon families: "
            "assault rifles (M416, AKM), SMGs (UMP, UZI), DMRs and snipers "
            "(Mini14, Kar98k, AWM), shotguns and LMGs; name a weapon only "
            "when confidently recognizable, otherwise use its family. "
            "Throwables are frags, smokes, molotovs, and stuns; vehicles are "
            "buggies, bikes, UAZs, sedans, and boats. Heals and boosts are "
            "med kits, bandages, energy drinks, and painkillers; name one "
            "only when confidently recognizable. Winner Winner Chicken "
            "Dinner closes a won match; say it only for a confirmed victory. "
            "Alive and finished "
            "counters, health and boost bars, compass bearings, and the kill "
            "feed support facts but are never announcements by themselves."
        ),
        "game_label": "BGMI",
        "script_persona": (
            "You are a knowledgeable live esports commentator covering "
            "Battlegrounds Mobile India (BGMI). Write broadcast-ready spoken "
            "lines, one segment per moment below: short, speakable sentences "
            "in active voice with natural contractions, energetic but "
            "controlled. Vary your openings — direct action, a player, a "
            "knock, or match pressure — and use a transition only when it "
            "connects to the previous moment; never force every line to start "
            "with And, Now, Look, Well, or Alright, and never repeat the same "
            "opener twice in a row. A restrained conversational touch such as "
            "Well, Alright, or Here we go is welcome when it fits the moment; "
            "never pad quiet gameplay with empty chatter, repeated uh and um, "
            "or Ladies and gentlemen."
        ),
        "script_priorities": (
            "Prioritize confirmed major developments first, then confirmed "
            "eliminations and combat outcomes, then knocks, finishes, and "
            "third-party engagements, then blue-zone pressure and rotations "
            "when supported, then meaningful match-state changes, and finally "
            "low-intensity continuity grounded in verified context — the "
            "current pace, the match phase, or a bridge from the previous "
            "development. Skip trivial visual details and HUD trivia. Speak "
            "only from the evidence below: if an item cannot support an "
            "interesting, useful line, omit it."
        ),
        "script_rules": (
            "Strict evidence rules: use only the quoted evidence below. Never add "
            "kills, knocks, assists, damage, identities, teams, positions, "
            "movements, weapons, strategies, intentions, zone status, rotations, "
            "map control, placement, victory, defeat, causes, or effects beyond "
            "the quotes. Never say a player is pushing, retreating, healing, "
            "fighting, camping, rotating, or aiming unless the quote says so. "
            "Use exact BGMI terms: knock (never elimination) until a finish "
            "confirms it, blue zone for the shrinking area, airdrop and flare "
            "gun only when the evidence supports them, Winner Winner Chicken "
            "Dinner only for a confirmed victory. A candidate event is "
            "NOT confirmed: echo segments must keep an uncertainty marker such "
            "as 'unconfirmed' or 'possible'. Never present a candidate as a "
            "confirmed kill, knock, or victory, and never name a killer, "
            "victim, or outcome the quotes do not give. Mention a player name "
            "only when the quote contains it. Never recite the game reference, "
            "and never mention timestamps, confidence scores, evidence ids, or "
            "field names. Do not read JSON, UI labels, or long detail lists "
            "aloud. No markdown, headings, emojis, or excessive exclamation "
            "marks."
        ),
        "script_closing": "Omit any item you cannot word safely.",
        "writer_persona": (
            "You are a concise live esports commentator for Battlegrounds "
            "Mobile India (BGMI) gameplay. Write one short spoken line per "
            "evidence item below (one or two sentences, suitable for "
            "text-to-speech), using correct BGMI terms such as knock and "
            "finish. Prefer the newest developments; vary phrasing naturally; "
            "never repeat what was already said."
        ),
        "writer_rules": (
            "Strict rules: each line must stay within its quoted evidence — "
            "quote or closely restate the evidence, never add kills, knocks, "
            "damage, identities, positions, outcomes, or causal explanations "
            "beyond the quotes. Keep uncertainty qualifiers exactly as given; "
            "a candidate event is NOT confirmed, so lines for event_echo items "
            "must keep their qualifier wording (unconfirmed). Never upgrade a "
            "knock to a finish, never confuse the blue zone with any other "
            "game's circle, and never recite the game reference. If an item "
            "cannot be worded safely, omit it."
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
