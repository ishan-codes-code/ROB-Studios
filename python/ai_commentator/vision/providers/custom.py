"""Custom adapter: user-configured OpenAI-compatible Chat Completions.

Unlike the curated providers, the endpoint URL and model ID come from
the saved vault record (validated main-side in Electron and re-validated
here). There is no curated model catalogue: model discovery (``GET
/models``) is best-effort and manual model entry is always supported.

Security posture:

- Only ``https://`` endpoints are accepted; credentials, query strings,
  fragments, and local/private-network targets are rejected both at
  configuration time (Electron ``validateCustomBaseUrl``) and here at
  request time.
- The API key is sent only to the configured host. The underlying HTTP
  client (httpx, via the OpenAI SDK) strips the ``Authorization`` header
  when following a redirect to a different origin, so a compromised or
  misconfigured endpoint cannot bounce the key to another host through
  an HTTP redirect. Same-origin redirects keep working.
- Failures are secret-free: keys are redacted from every message, and
  provider bodies are truncated before surfacing.
"""

from __future__ import annotations

import ipaddress
import json
import urllib.parse

from openai import APIError, OpenAI

from ...errors import ObservationError, VisionAPIError
from .base import (
    VisionProviderAdapter,
    classify_exception,
    classify_status,
    redact_secret,
)

PROVIDER_ID = "custom"

MAX_BASE_URL_LENGTH = 2048
MAX_MODEL_ID_LENGTH = 200
MAX_DISCOVERED_MODELS = 200

DISCOVERY_UNSUPPORTED = "discovery_unsupported"


class ModelDiscoveryError(Exception):
    """Raised when ``GET /models`` cannot produce a model list.

    ``code`` is ``discovery_unsupported`` when the endpoint does not
    implement model listing (caller should offer manual model entry),
    otherwise a standard adapter error code describing the real failure.
    """

    def __init__(self, message: str, code: str = DISCOVERY_UNSUPPORTED,
                 status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _is_blocked_host(hostname: str) -> bool:
    """True for loopback/link-local/private/unspecified targets."""
    host = (hostname or "").strip().lower().rstrip(".")
    if not host:
        return True
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return (
        address.is_loopback
        or address.is_link_local
        or address.is_private
        or address.is_unspecified
        or address.is_reserved
        or address.is_multicast
    )


def validate_base_url(base_url: str) -> str:
    """Validate + normalize a custom endpoint base URL.

    Mirrors the Electron configuration-time rules so a record edited
    outside the app (or an older vault entry) still fails closed here.
    Returns the canonical URL string (no trailing slash).
    """
    if not isinstance(base_url, str) or not base_url.strip():
        raise ValueError("A custom endpoint URL is required.")
    trimmed = base_url.strip()
    if len(trimmed) > MAX_BASE_URL_LENGTH:
        raise ValueError("Custom endpoint URL is too long.")
    try:
        parsed = urllib.parse.urlsplit(trimmed)
    except ValueError:
        raise ValueError("Custom endpoint URL must be a valid HTTPS URL.") from None
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "Custom endpoint URL must be HTTPS without credentials, "
            "query, or fragment."
        )
    if _is_blocked_host(parsed.hostname):
        raise ValueError(
            "Custom endpoints on local or private networks are not allowed."
        )
    return trimmed.rstrip("/")


def validate_model_id(model: str) -> str:
    """Validate an explicit (non-curated) custom model ID."""
    if not isinstance(model, str) or not model.strip():
        raise ValueError("A vision model ID is required.")
    clean = model.strip()
    if len(clean) > MAX_MODEL_ID_LENGTH:
        raise ValueError("Vision model ID is too long.")
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in clean):
        raise ValueError("Vision model ID contains invalid characters.")
    return clean


def _provider_body_text(exc: Exception, api_key: str, limit: int = 300) -> str:
    """Sanitized provider response body for diagnostics (never secrets)."""
    body = getattr(exc, "body", None)
    if body is None:
        return ""
    text = ""
    if isinstance(body, dict):
        for key in ("message", "error", "detail"):
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                text = value.strip()
                break
            if isinstance(value, dict):
                nested = value.get("message")
                if isinstance(nested, str) and nested.strip():
                    text = nested.strip()
                    break
        if not text:
            try:
                text = json.dumps(body, separators=(",", ":"), default=str)
            except Exception:
                text = str(body)
    elif isinstance(body, str):
        text = body
    else:
        text = str(body)
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[:limit] + "...(truncated)"
    return redact_secret(text, api_key)


from ..verify import (
    VERIFY_IMAGE_DATA_URL,
    VERIFY_PROMPT,
    validate_verify_text,
)


class CustomAdapter(VisionProviderAdapter):
    """Vision provider speaking a user-configured OpenAI-compatible API."""

    provider_id = PROVIDER_ID

    def __init__(self, model: str, api_key: str, base_url: str = "",
                 timeout: float = 60.0, client=None) -> None:
        clean_base = validate_base_url(base_url)
        super().__init__(model=validate_model_id(model), api_key=api_key,
                         timeout=timeout)
        self.base_url = clean_base
        self._owned = client is None
        self._client = client or OpenAI(
            api_key=api_key, base_url=clean_base, timeout=timeout,
            max_retries=0,
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
            print(f"Custom API response: HTTP {raw_response.status_code}")
            response = raw_response.parse()
        except APIError as exc:
            raise self._wrap_error(exc) from None
        except ObservationError:
            raise
        except Exception as exc:
            raise VisionAPIError(
                f"Custom API request error: "
                f"{redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider=PROVIDER_ID,
            ) from None
        return prompts.extract_response_text(response)

    def request_adaptive_batch_text(self, timestamps, image_data_urls,
                                    previous=None) -> str:
        """Request one multi-frame adaptive document for HIGH-speed sampling.

        ``timestamps`` and ``image_data_urls`` are parallel chronological
        lists; images are attached in order after the batch prompt.
        """
        prompts = self._prompts()
        content = [
            {"type": "text",
             "text": prompts.build_adaptive_batch_prompt(
                 list(timestamps), previous)},
        ]
        for image_data_url in image_data_urls:
            content.append(
                {"type": "image_url", "image_url": {"url": image_data_url}}
            )
        try:
            raw_response = self._client.chat.completions.with_raw_response.create(
                model=self.model,
                messages=[
                    {
                        "role": "user",
                        "content": content,
                    }
                ],
                timeout=self.timeout,
            )
            print(f"Custom API response: HTTP {raw_response.status_code}")
            response = raw_response.parse()
        except APIError as exc:
            raise self._wrap_error(exc) from None
        except ObservationError:
            raise
        except Exception as exc:
            raise VisionAPIError(
                f"Custom API request error: "
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
            print(f"Custom API response: HTTP {raw_response.status_code}")
            response = raw_response.parse()
        except APIError as exc:
            raise self._wrap_error(exc) from None
        except ObservationError:
            raise
        except Exception as exc:
            raise VisionAPIError(
                f"Custom API request error: "
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
                f"Custom API request error: "
                f"{redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider=PROVIDER_ID,
            ) from None
        choices = getattr(response, "choices", None) or []
        message = getattr(choices[0], "message", None) if choices else None
        text = getattr(message, "content", None)
        if not isinstance(text, str) or not text.strip():
            raise ObservationError("Custom endpoint returned no text content.")
        return text

    def verify_connection(self) -> None:
        # No /models assumption: some OpenAI-compatible endpoints do not
        # implement listing. The cheapest authenticated check is a minimal
        # text-only completion against the configured model.
        try:
            response = self._client.chat.completions.create(
                model=self.model,
                max_tokens=16,
                messages=[{"role": "user",
                           "content": "Reply with the word OK."}],
            )
        except APIError as exc:
            raise self._wrap_error(exc) from None
        except Exception as exc:
            raise VisionAPIError(
                f"Custom API request error: "
                f"{redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider=PROVIDER_ID,
            ) from None
        choices = getattr(response, "choices", None) or []
        message = getattr(choices[0], "message", None) if choices else None
        text = getattr(message, "content", None)
        if not isinstance(text, str) or not text.strip():
            raise ObservationError("Custom endpoint returned no text content.")

    def verify_image(self, model: str | None = None) -> None:
        target = validate_model_id(model or self.model)
        try:
            # Minimal valid image request; may incur provider charges.
            # No provider-specific extra parameters: unknown endpoints
            # must accept the plain Chat Completions shape.
            response = self._client.chat.completions.create(
                model=target,
                max_tokens=512,
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
                f"Custom API request error: "
                f"{redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider=PROVIDER_ID,
            ) from None
        choices = getattr(response, "choices", None) or []
        if not choices:
            raise ObservationError("Custom endpoint returned no choices.")
        message = getattr(choices[0], "message", None)
        if message is None:
            raise ObservationError("Custom endpoint returned no message.")
        if getattr(choices[0], "finish_reason", None) == "length":
            raise VisionAPIError(
                "Custom endpoint used up its output budget before "
                "producing an answer. Try again.",
                code="output_exhausted",
                provider=PROVIDER_ID,
            )
        text = getattr(message, "content", None)
        validate_verify_text(text, "Custom endpoint")

    def list_models(self) -> list[str]:
        """Return discovered model IDs from ``GET /models`` (bounded).

        Raises :class:`ModelDiscoveryError` with
        ``code == discovery_unsupported`` when the endpoint does not
        implement listing, so the caller can offer manual model entry.
        Any other failure keeps its real error code (auth, network, …).
        """
        try:
            result = self._client.models.list()
        except APIError as exc:
            status = getattr(exc, "status_code", None)
            if not isinstance(status, int):
                status = getattr(getattr(exc, "response", None),
                                 "status_code", None)
            if status in (404, 405, 501):
                raise ModelDiscoveryError(
                    "This endpoint does not list models. "
                    "Enter the model ID manually.",
                    code=DISCOVERY_UNSUPPORTED,
                    status=status,
                ) from None
            raise self._wrap_error(exc) from None
        except Exception as exc:
            raise VisionAPIError(
                f"Custom API request error: "
                f"{redact_secret(str(exc), self.api_key)}",
                code=classify_exception(exc),
                provider=PROVIDER_ID,
            ) from None
        data = getattr(result, "data", None)
        if data is None and isinstance(result, dict):
            data = result.get("data")
        if not isinstance(data, (list, tuple)):
            raise ModelDiscoveryError(
                "This endpoint did not return a model list. "
                "Enter the model ID manually.",
                code=DISCOVERY_UNSUPPORTED,
            )
        seen: list[str] = []
        for entry in data:
            model_id = getattr(entry, "id", None)
            if model_id is None and isinstance(entry, dict):
                model_id = entry.get("id")
            if not isinstance(model_id, str) or not model_id.strip():
                continue
            clean = model_id.strip()
            if clean not in seen:
                seen.append(clean)
            if len(seen) >= MAX_DISCOVERED_MODELS:
                break
        return seen

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
        detail = (_provider_body_text(exc, self.api_key)
                  or getattr(exc, "message", None) or str(exc))
        if exc.__cause__:
            detail = f"{detail} Cause: {exc.__cause__}"
        message = f"Custom API {status}: {redact_secret(detail, self.api_key)}"
        code = classify_status(status_code if isinstance(status_code, int) else None)
        if kind == "Writer":
            return WriterAPIError(message, code=code, status=status_code,
                                  provider=PROVIDER_ID)
        return VisionAPIError(message, code=code, status=status_code,
                              provider=PROVIDER_ID)
