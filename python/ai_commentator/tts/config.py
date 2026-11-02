"""Curated Gemini TTS configuration and validation.

Only the two documented Flash TTS models are supported; the model is a
pinned choice, never free text. Voices are validated as bounded strings
so prebuilt voices, Extended Voice Library IDs, and custom
``voice_...`` IDs all work without hardcoding availability.
"""

TTS_MODELS = (
    "gemini-3.8-flash-tts",
    "gemini-3.8-flash-lite-tts",
)
DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts"

DEFAULT_TTS_VOICE = "Kore"
MAX_TTS_VOICE_LENGTH = 64

DEFAULT_TTS_VOICE_DIRECTION = (
    "Energetic esports commentator: fast-paced, confident, expressive "
    "delivery with clear, natural pronunciation."
)
MAX_TTS_VOICE_DIRECTION_LENGTH = 500

# Prebuilt studio voices from the official TTS guide
# (https://aistudio.google.com/docs/speech-generation#voices):
# (voice id, short character description).
PREBUILT_VOICES = (
    ("Zephyr", "Bright"),
    ("Puck", "Upbeat"),
    ("Charon", "Informative"),
    ("Kore", "Firm"),
    ("Fenrir", "Excitable"),
    ("Leda", "Youthful"),
    ("Orus", "Firm"),
    ("Aoede", "Breezy"),
    ("Callirrhoe", "Easy-going"),
    ("Autonoe", "Bright"),
    ("Enceladus", "Breathy"),
    ("Iapetus", "Clear"),
    ("Umbriel", "Easy-going"),
    ("Algieba", "Smooth"),
    ("Despina", "Smooth"),
    ("Erinome", "Clear"),
    ("Algenib", "Gravelly"),
    ("Rasalgethi", "Informative"),
    ("Laomedeia", "Upbeat"),
    ("Achernar", "Soft"),
    ("Alnilam", "Firm"),
    ("Schedar", "Even"),
    ("Gacrux", "Mature"),
    ("Pulcherrima", "Forward"),
    ("Achird", "Friendly"),
    ("Zubenelgenubi", "Casual"),
    ("Vindemiatrix", "Gentle"),
    ("Sadachbia", "Lively"),
    ("Sadaltager", "Knowledgeable"),
    ("Sulafat", "Warm"),
)

TTS_MANIFEST_FILENAME = "tts.json"
TTS_COMBINED_FILENAME = "combined.wav"


def validate_tts_voice(voice: str) -> str:
    """Validate a voice identifier (prebuilt, library, or custom ID)."""
    if not isinstance(voice, str) or not voice.strip():
        raise ValueError("TTS voice is required.")
    clean = voice.strip()
    if len(clean) > MAX_TTS_VOICE_LENGTH:
        raise ValueError("TTS voice identifier is too long.")
    return clean


def validate_tts_voice_direction(direction: str) -> str:
    """Validate the natural-language voice direction (style metadata)."""
    if not isinstance(direction, str) or not direction.strip():
        raise ValueError("TTS voice direction is required.")
    clean = direction.strip()
    if len(clean) > MAX_TTS_VOICE_DIRECTION_LENGTH:
        raise ValueError("TTS voice direction is too long.")
    return clean


def validate_tts_model(model: str) -> str:
    """Validate the pinned TTS model choice (no silent substitution)."""
    if model not in TTS_MODELS:
        raise ValueError(
            f"Unsupported TTS model {model!r}; supported: {', '.join(TTS_MODELS)}."
        )
    return model


def validate_tts_config(model: str, voice: str, voice_direction: str):
    """Validate a full TTS configuration triple, returning cleaned values."""
    return (
        validate_tts_model(model),
        validate_tts_voice(voice),
        validate_tts_voice_direction(voice_direction),
    )


def generation_identity(script_bytes: bytes, model: str, voice: str,
                        voice_direction: str) -> str:
    """Stable identity for a script + TTS configuration combination."""
    import hashlib

    digest = hashlib.sha256()
    digest.update(script_bytes)
    digest.update(b"\x00")
    digest.update(model.encode("utf-8"))
    digest.update(b"\x00")
    digest.update(voice.encode("utf-8"))
    digest.update(b"\x00")
    digest.update(voice_direction.encode("utf-8"))
    return digest.hexdigest()
