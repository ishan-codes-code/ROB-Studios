"""Prompt-pack resolution: customized fields over factory defaults.

Selection arrives from the run environment (Electron resolves the full
project/global/application precedence main-side and passes the result in
``AI_COMMENTATOR_SETTINGS_JSON.promptPack``); a standalone
``AI_COMMENTATOR_PACK_ID`` covers CLI runs. Resolution here is the last
step only: pick the factory pack, overlay non-empty custom fields.

Empty custom text always falls back to the factory default, so clearing a
field in the UI is equivalent to resetting it.
"""

import json
import os

from .packs import DEFAULT_PACK_ID, PACK_FIELDS, PACK_IDS, get_factory_pack

PACK_ID_ENV_VAR = "AI_COMMENTATOR_PACK_ID"
SETTINGS_ENV_VAR = "AI_COMMENTATOR_SETTINGS_JSON"

#: Default prompt pack per project game id, used only when neither the
#: settings snapshot nor the standalone env var selects a pack. Unknown
#: games fall back to the application default.
GAME_DEFAULT_PACK_IDS = {
    "free-fire": DEFAULT_PACK_ID,
    "cod": "cod",
    "bgmi": "bgmi",
}


def default_pack_id_for_game(game_id):
    """Return the default pack for a game id (or the app default)."""
    if isinstance(game_id, str):
        mapped = GAME_DEFAULT_PACK_IDS.get(game_id.strip())
        if mapped in PACK_IDS:
            return mapped
    return DEFAULT_PACK_ID


def prompt_pack_selection():
    """Return ``(pack_id, custom)`` from the environment.

    Precedence: settings ``promptPack.packId`` first, then the standalone
    pack-id env var, then the project ``game.id`` default, then the Free
    Fire default. ``custom`` is the ``{field: text}`` overlay (possibly
    empty). Malformed settings never raise: they resolve to the default
    pack with no customization.
    """
    pack_id = None
    custom = {}
    raw_id = os.environ.get(PACK_ID_ENV_VAR, "")
    if isinstance(raw_id, str) and raw_id.strip():
        pack_id = raw_id.strip()
    game_id = None
    try:
        settings = json.loads(os.environ.get(SETTINGS_ENV_VAR, "{}"))
        selection = settings.get("promptPack", {})
        if isinstance(selection, dict):
            if isinstance(selection.get("packId"), str) and selection["packId"].strip():
                pack_id = selection["packId"].strip()
            if isinstance(selection.get("custom"), dict):
                custom = selection["custom"]
        game = settings.get("game", {})
        if isinstance(game, dict):
            game_id = game.get("id")
    except (ValueError, TypeError, AttributeError):
        pass
    if pack_id is None:
        pack_id = default_pack_id_for_game(game_id)
    return pack_id, custom


def validate_custom_fields(custom):
    """Return cleaned ``{field: text}``; raise ValueError on bad input."""
    if custom is None:
        return {}
    if not isinstance(custom, dict):
        raise ValueError("Prompt-pack customization must be an object.")
    cleaned = {}
    for key, value in custom.items():
        if key not in PACK_FIELDS:
            raise ValueError(f"Unknown prompt-pack field {key!r}.")
        if not isinstance(value, str):
            raise ValueError(f"Prompt-pack field {key!r} must be a string.")
        text = value.strip()
        if not text:
            continue
        limit = PACK_FIELDS[key]["max_chars"]
        if len(text) > limit:
            raise ValueError(
                f"Prompt-pack field {key!r} exceeds {limit} characters."
            )
        cleaned[key] = text
    return cleaned


def resolve_pack(pack_id=None, custom=None):
    """Return the effective pack: factory defaults plus custom overlays.

    ``pack_id``/``custom`` default to the environment selection. The result
    is ``{"pack_id", "display_name", "version", "fields", "customized"}``
    where ``customized`` lists the fields the user overrode. Factory data
    is copied, never mutated. Raises ValueError for unknown packs or
    invalid custom text.
    """
    env_pack_id, env_custom = prompt_pack_selection()
    if pack_id is None:
        pack_id = env_pack_id
    if custom is None:
        custom = env_custom
    factory = get_factory_pack(pack_id)
    cleaned = validate_custom_fields(custom)
    fields = dict(factory["fields"])
    fields.update(cleaned)
    return {
        "pack_id": factory["pack_id"],
        "display_name": factory["display_name"],
        "version": factory["version"],
        "fields": fields,
        "customized": sorted(cleaned),
    }


def coerce_pack(pack):
    """Normalize a builder ``pack`` argument to an effective pack dict.

    Accepts None (resolve from the environment), a pack id string, or an
    already-resolved pack dict. Anything else raises ValueError.
    """
    if pack is None:
        return resolve_pack()
    if isinstance(pack, str):
        return resolve_pack(pack_id=pack, custom={})
    if isinstance(pack, dict) and isinstance(pack.get("fields"), dict):
        return pack
    raise ValueError("Invalid prompt pack argument.")


def effective_game_context(pack):
    """Combine pack context with the project match context (both bounded).

    The pack's ``game_context`` field (static game knowledge) comes first;
    the per-project ``game.context`` preference (``user_prompt_preferences``)
    is appended so current projects keep their settings. Each part carries
    a label so prompts distinguish static reference knowledge from this
    project's match details; empty parts (and their labels) are dropped.
    """
    from ..config import user_prompt_preferences

    fields = coerce_pack(pack)["fields"]
    label = fields.get("game_label", "") or "game"
    parts = []
    static_context = (fields.get("game_context") or "").strip()
    if static_context:
        parts.append(f"Game reference ({label} knowledge): {static_context}")
    project_context = user_prompt_preferences().get("game_context", "")
    if project_context:
        parts.append(
            "Match details (this project; context only, never events): "
            f"{project_context}"
        )
    return " ".join(parts)
