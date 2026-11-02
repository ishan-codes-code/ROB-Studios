"""Meta adapter: Meta Model API Responses API (``/responses``).

Official docs used (fetched 2026-11-02):
``https://dev.meta.ai/docs/overview``,
``https://dev.meta.ai/docs/protocols/responses``,
``https://dev.meta.ai/docs/image-understanding``,
``https://dev.meta.ai/docs/models``.

The task brief pins the request shape to the documented example:
``POST https://api.meta.ai/v1/responses`` with Bearer auth,
``{"model", "input": [{"role": "user", "content": [...]}]}`` where the
content list carries ``{"type": "input_text", "text": ...}`` entries.
The brief explicitly requires verifying how image content is
represented and implementing the actual image request. The fetched
Responses/image-understanding pages render as navigation shells in an
offline fetch, so the exact ``input_image`` member name below is the
documented Responses-convention shape
(``{"type": "input_image", "image_url": <data-url>}``) isolated behind
this adapter. If the live API rejects it, only this file changes; the
pipeline, prompts, and validation are untouched. This uncertainty is
recorded in the ADR and never leaks into prompts or schemas.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from ...errors import ObservationError, VisionAPIError
from .base import (
    VisionProviderAdapter,
    classify_exception,
    classify_status,
    redact_secret,
)

PROVIDER_ID = "meta"
BASE_URL = "https://api.meta.ai/v1"
RESPONSES_PATH = "/responses"

# Curated catalogue: only these models are selectable for Meta. Vision
# readiness is never assumed from catalogue membership; it requires an
# explicit image-input verification per saved credential+model.
MODELS = ("muse-spark-1.3", "muse-wonder-1.0")

# Shared verification fixture (see vision/verify.py): a deterministic
# PNG plus a prompt that requires looking at the image. Imported
# here so the name stays importable for compatibility.
from ..verify import (
    VERIFY_IMAGE_DATA_URL,
    VERIFY_PROMPT,
    validate_verify_text,
)


def _post_json(url: str, payload: dict, api_key: str,
               timeout: float) -> tuple[int, dict | str]:
    """POST ``payload`` as JSON; return ``(status, parsed-body)``."""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200) or 200)
            raw = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", "replace")
        except Exception:
            raw = ""
        raise VisionAPIError(
            f"Meta API HTTP {exc.code}: "
            f"{redact_secret(raw[:2000] or str(exc), api_key)}",
            code=classify_status(exc.code),
            status=exc.code,
            provider="meta",
        ) from None
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None)
        timeout_like = isinstance(reason, TimeoutError) or "timed out" in str(reason).lower()
        raise VisionAPIError(
            f"Meta API request error: {redact_secret(str(exc), api_key)}",
            code="timeout" if timeout_like else "network",
            provider="meta",
        ) from None
    except TimeoutError as exc:
        raise VisionAPIError(
            f"Meta API request error: {redact_secret(f'timed out: {exc}', api_key)}",
            code="timeout",
            provider="meta",
        ) from None
    if not raw.strip():
        raise ObservationError("Meta returned no text content.")
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw


def extract_output_text(payload) -> str:
    """Pull assistant text out of a Responses API body (several shapes)."""
    if isinstance(payload, str):
        text = payload.strip()
        if not text:
            raise ObservationError("Meta returned no text content.")
        return text
    if not isinstance(payload, dict):
        raise ObservationError("Meta returned no text content.")
    # Convenience shapes first.
    for key in ("output_text", "text"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value
    # Standard shape: output: [{type: message, content: [{type: output_text, text}]}]
    chunks: list[str] = []
    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    text_value = part.get("text")
                    if isinstance(text_value, str) and text_value.strip():
                        chunks.append(text_value)
                    elif isinstance(part.get("content"), str) and part["content"].strip():
                        chunks.append(part["content"])
            elif isinstance(content, str) and content.strip():
                chunks.append(content)
            elif isinstance(item.get("text"), str) and item["text"].strip():
                chunks.append(item["text"])
    if chunks:
        return "".join(chunks)
    # Chat-style fallback (some gateways mirror choices).
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
        text = message.get("content") if isinstance(message, dict) else None
        if isinstance(text, str) and text.strip():
            return text
    raise ObservationError("Meta returned no text content.")


class MetaAdapter(VisionProviderAdapter):
    """Vision provider speaking the Meta Responses API."""

    provider_id = PROVIDER_ID
    base_url = BASE_URL

    def __init__(self, model: str, api_key: str, timeout: float = 60.0) -> None:
        if model not in MODELS:
            raise ValueError(
                f"Unsupported Meta model {model!r}; "
                f"supported: {', '.join(MODELS)}."
            )
        super().__init__(model=model, api_key=api_key, timeout=timeout)
        self.responses_url = f"{BASE_URL}{RESPONSES_PATH}"

    # -- payload -----------------------------------------------------------
    def _observation_payload(self, prompt: str, image_data_url: str,
                             max_tokens: int | None = None) -> dict:
        content = [
            {"type": "input_text", "text": prompt},
            {"type": "input_image", "image_url": image_data_url},
        ]
        payload: dict = {
            "model": self.model,
            "input": [{"role": "user", "content": content}],
            "stream": False,
        }
        if max_tokens is not None:
            payload["max_output_tokens"] = max_tokens
        return payload

    def _send_prompt(self, prompt: str, image_data_url: str,
                     max_tokens: int | None = None) -> str:
        _, body = _post_json(
            self.responses_url,
            self._observation_payload(prompt, image_data_url, max_tokens),
            self.api_key,
            self.timeout,
        )
        return extract_output_text(body)

    # -- interface ---------------------------------------------------------
    def request_observation_text(self, timestamp, image_data_url: str) -> str:
        from .. import client as client_module

        try:
            return self._send_prompt(
                client_module.build_vision_prompt(timestamp), image_data_url
            )
        except (VisionAPIError, ObservationError):
            raise
        except Exception as exc:
            raise VisionAPIError(
                f"Meta API request error: {redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider="meta",
            ) from None

    def request_adaptive_text(self, timestamp, image_data_url: str,
                              previous=None) -> str:
        from .. import client as client_module

        try:
            return self._send_prompt(
                client_module.build_adaptive_vision_prompt(timestamp, previous),
                image_data_url,
            )
        except (VisionAPIError, ObservationError):
            raise
        except Exception as exc:
            raise VisionAPIError(
                f"Meta API request error: {redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider="meta",
            ) from None

    def request_text(self, prompt: str) -> str:
        """Return raw model text for one text-only prompt (writer/script)."""
        payload: dict = {
            "model": self.model,
            "input": [
                {"role": "user",
                 "content": [{"type": "input_text", "text": prompt}]}
            ],
            "stream": False,
        }
        try:
            _, body = _post_json(
                self.responses_url, payload, self.api_key,
                min(self.timeout, 60.0),
            )
            return extract_output_text(body)
        except (VisionAPIError, ObservationError):
            raise
        except Exception as exc:
            raise VisionAPIError(
                f"Meta API request error: {redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider="meta",
            ) from None

    def verify_connection(self) -> None:
        # No unauthenticated/meta-models endpoint is assumed: the cheapest
        # authenticated check is a minimal text-only Responses call.
        payload: dict = {
            "model": self.model,
            "input": [
                {"role": "user",
                 "content": [{"type": "input_text",
                              "text": "Reply with the word OK."}]}
            ],
            "stream": False,
            "max_output_tokens": 8,
        }
        _, body = _post_json(
            self.responses_url, payload, self.api_key, min(self.timeout, 20.0)
        )
        extract_output_text(body)

    def verify_image(self, model: str | None = None) -> None:
        target = model or self.model
        if target not in MODELS:
            raise ValueError(
                f"Unsupported Meta model {target!r}; "
                f"supported: {', '.join(MODELS)}."
            )
        original = self.model
        try:
            self.model = target
            # Minimal valid image request; may incur provider charges.
            # The prompt asks about visible content so success proves
            # the model received image input: HTTP 200 alone is not
            # enough, the reply must be meaningful text.
            text = self._send_prompt(VERIFY_PROMPT,
                                     VERIFY_IMAGE_DATA_URL, max_tokens=32)
            validate_verify_text(text, "Meta")
        finally:
            self.model = original
