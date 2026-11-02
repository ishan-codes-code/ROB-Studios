"""Baseten adapter: OpenAI-compatible Chat Completions (pinned model)."""

from __future__ import annotations

import os

from openai import APIError, OpenAI

from ...errors import ObservationError, VisionAPIError
from .base import (
    VisionProviderAdapter,
    classify_exception,
    classify_status,
    redact_secret,
)

PROVIDER_ID = "baseten"
BASE_URL = "https://inference.baseten.co/v1"
MODEL = "meta-models/muse-spark-open-1026"

# Shared verification fixture (see vision/verify.py): a deterministic PNG
# plus a prompt that requires looking at the image. Kept importable here
# for compatibility.
from ..verify import (
    VERIFY_IMAGE_DATA_URL,
    VERIFY_PROMPT,
    validate_verify_text,
)


class BasetenAdapter(VisionProviderAdapter):
    """Vision provider speaking Baseten's OpenAI-compatible API."""

    provider_id = PROVIDER_ID
    base_url = BASE_URL

    def __init__(self, model: str = MODEL, api_key: str = "", timeout: float = 60.0,
                 client=None) -> None:
        if model != MODEL:
            raise ValueError(
                f"Unsupported Baseten model {model!r}; only {MODEL!r} is available."
            )
        super().__init__(model=model, api_key=api_key, timeout=timeout)
        self._owned = client is None
        self._client = client or OpenAI(
            api_key=api_key, base_url=BASE_URL, timeout=timeout, max_retries=0
        )

    # -- prompt helpers (lazy import avoids cycles) ------------------------
    @staticmethod
    def _prompts():
        from .. import client as client_module

        return client_module

    def request_observation_text(self, timestamp, image_data_url: str) -> str:
        prompts = self._prompts()
        try:
            raw_response = self._client.chat.completions.with_raw_response.create(
                model=self.model,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text",
                             "text": prompts.build_vision_prompt(timestamp)},
                            {"type": "image_url",
                             "image_url": {"url": image_data_url}},
                        ],
                    }
                ],
            )
            print(f"Baseten API response: HTTP {raw_response.status_code}")
            response = raw_response.parse()
        except APIError as exc:
            raise self._wrap_error(exc) from None
        except ObservationError:
            raise
        except Exception as exc:
            raise VisionAPIError(
                f"Baseten API request error: "
                f"{redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider=PROVIDER_ID,
            ) from None
        return prompts.extract_response_text(response)

    def request_adaptive_text(self, timestamp, image_data_url: str,
                              previous=None) -> str:
        prompts = self._prompts()
        try:
            raw_response = self._client.chat.completions.with_raw_response.create(
                model=self.model,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text",
                             "text": prompts.build_adaptive_vision_prompt(
                                 timestamp, previous)},
                            {"type": "image_url",
                             "image_url": {"url": image_data_url}},
                        ],
                    }
                ],
                timeout=self.timeout,
            )
            print(f"Baseten API response: HTTP {raw_response.status_code}")
            response = raw_response.parse()
        except APIError as exc:
            raise self._wrap_error(exc) from None
        except ObservationError:
            raise
        except Exception as exc:
            raise VisionAPIError(
                f"Baseten API request error: "
                f"{redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider=PROVIDER_ID,
            ) from None
        return prompts.extract_response_text(response)

    def request_text(self, prompt: str) -> str:
        """Return raw model text for one text-only prompt (writer/script)."""
        from ...errors import ObservationError, WriterAPIError

        try:
            response = self._client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
            )
        except APIError as exc:
            raise self._wrap_error(exc, kind="Writer") from None
        except Exception as exc:
            raise WriterAPIError(
                f"Baseten API request error: "
                f"{redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider=PROVIDER_ID,
            ) from None
        choices = getattr(response, "choices", None) or []
        message = getattr(choices[0], "message", None) if choices else None
        text = getattr(message, "content", None)
        if not isinstance(text, str) or not text.strip():
            raise ObservationError("Baseten returned no text content.")
        return text

    def verify_connection(self) -> None:
        try:
            self._client.models.list()
        except APIError as exc:
            raise self._wrap_error(exc) from None
        except Exception as exc:
            raise VisionAPIError(
                f"Baseten API request error: "
                f"{redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider=PROVIDER_ID,
            ) from None

    def verify_image(self, model: str | None = None) -> None:
        target = model or self.model
        if target != MODEL:
            raise ValueError(
                f"Unsupported Baseten model {target!r}; only {MODEL!r} is available."
            )
        try:
            response = self._client.chat.completions.create(
                model=target,
                max_tokens=32,
                messages=[{"role": "user", "content": [
                    {"type": "text", "text": VERIFY_PROMPT},
                    {"type": "image_url",
                     "image_url": {"url": VERIFY_IMAGE_DATA_URL}},
                ]}],
            )
        except APIError as exc:
            raise self._wrap_error(exc) from None
        except Exception as exc:
            raise VisionAPIError(
                f"Baseten API request error: "
                f"{redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider=PROVIDER_ID,
            ) from None
        choices = getattr(response, "choices", None) or []
        message = getattr(choices[0], "message", None) if choices else None
        text = getattr(message, "content", None)
        validate_verify_text(text, "Baseten")

    def close(self) -> None:
        if self._owned:
            try:
                self._client.close()
            except Exception:
                pass

    # -- internals ---------------------------------------------------------
    def _wrap_error(self, exc: Exception, kind: str = "Vision") -> VisionAPIError:
        from ...errors import WriterAPIError

        status_code = getattr(exc, "status_code", None)
        if not isinstance(status_code, int):
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            if not isinstance(status_code, int):
                status_code = None
        status = f"HTTP {status_code}" if status_code else "request error"
        detail = getattr(exc, "message", None) or str(exc)
        if exc.__cause__:
            detail = f"{detail} Cause: {exc.__cause__}"
        message = f"Baseten API {status}: {redact_secret(detail, self.api_key)}"
        code = classify_status(status_code if isinstance(status_code, int) else None)
        if kind == "Writer":
            return WriterAPIError(message, code=code, status=status_code,
                                  provider=PROVIDER_ID)
        return VisionAPIError(message, code=code, status=status_code,
                              provider=PROVIDER_ID)


def build_live_adapter(api_key: str | None = None,
                        timeout: float = 60.0) -> BasetenAdapter:
    """Build a Baseten adapter from the explicit or legacy environment."""
    key = api_key if api_key else os.environ.get("BASETEN_API_KEY", "")
    model = os.environ.get("BASETEN_MODEL", MODEL) or MODEL
    if not key:
        raise RuntimeError("BASETEN_API_KEY is not set in the environment.")
    return BasetenAdapter(model=model, api_key=key, timeout=timeout)
