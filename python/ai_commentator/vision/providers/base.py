"""Shared provider-adapter interface and secret hygiene."""

from __future__ import annotations


def redact_secret(text: str, secrets: list[str] | tuple[str, ...] | str | None) -> str:
    """Replace every non-empty secret in ``text`` with ``[REDACTED]``."""
    if not isinstance(text, str):
        text = str(text)
    if isinstance(secrets, str):
        candidates = [secrets]
    else:
        candidates = list(secrets or [])
    for secret in candidates:
        if isinstance(secret, str) and secret:
            text = text.replace(secret, "[REDACTED]")
    return text


class VisionProviderAdapter:
    """Minimal interface the vision pipeline needs from any provider."""

    provider_id: str = "unknown"
    model: str = ""
    base_url: str = ""

    def __init__(self, model: str, api_key: str, timeout: float = 60.0) -> None:
        if not isinstance(model, str) or not model.strip():
            raise ValueError("A vision model ID is required.")
        if not isinstance(api_key, str) or not api_key:
            raise ValueError("A provider API key is required.")
        self.model = model.strip()
        self.api_key = api_key
        self.timeout = float(timeout)

    # -- core vision operations -------------------------------------------
    def request_observation_text(self, timestamp, image_data_url: str) -> str:
        """Return raw model text for one batch frame observation."""
        raise NotImplementedError

    def request_adaptive_text(
        self,
        timestamp,
        image_data_url: str,
        previous=None,
    ) -> str:
        """Return raw model text for one adaptive wrapper response."""
        raise NotImplementedError

    # -- verification operations ------------------------------------------
    def request_text(self, prompt: str) -> str:
        """Return raw model text for one text-only prompt (no images)."""
        raise NotImplementedError

    def verify_connection(self) -> None:
        """Raise on failure; return None when the credential reaches the API."""
        raise NotImplementedError

    def verify_image(self, model: str | None = None) -> None:
        """Send a minimal valid image request; raise on failure."""
        raise NotImplementedError

    def close(self) -> None:
        """Release owned transport resources (idempotent)."""

    # -- context-manager support so adapters work with existing code ------
    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False
