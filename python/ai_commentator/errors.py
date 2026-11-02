class ObservationError(ValueError):
    """Model output failed observation-v1 parsing or validation."""


class VisionAPIError(RuntimeError):
    """Vision request failed; the message is already redacted.

    Optional structured fields survive message-level handling so the
    setup probe can report a diagnosable, secret-free failure:
    ``code`` is a stable category, ``status`` the HTTP status when
    known, and ``provider`` the adapter id.
    """

    def __init__(self, message, *, code="provider_error", status=None,
                 provider=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.provider = provider


class WriterAPIError(RuntimeError):
    """Commentary-writer request failed; the message is already redacted."""

    def __init__(self, message, *, code="provider_error", status=None,
                 provider=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.provider = provider


