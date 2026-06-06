"""Exception hierarchy raised by the SDK.

Two layers:

* :class:`SignalSDKError` — anything the SDK raises, usable as the
  catch-all in worker code that doesn't care about the cause.
* Specific subclasses for the cases workers commonly want to handle
  differently: auth, rate-limiting, validation, and "other server
  rejection".

Transient network errors propagate from ``httpx`` directly; the SDK's
retry loop converts repeated transients into
:class:`SignalTransportError` once it gives up.
"""

from __future__ import annotations

from typing import Any


class SignalSDKError(Exception):
    """Base class for any error raised inside the SDK."""


class SignalValidationError(SignalSDKError):
    """Raised when a payload fails client-side validation before send,
    or when the server returns ``validation_error`` (400)."""

    def __init__(
        self,
        message: str,
        *,
        index: int | None = None,
        field: str | None = None,
        body: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.index = index
        self.field = field
        self.body = body


class SignalAuthError(SignalSDKError):
    """Server rejected the bearer token (401 / 403)."""

    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class SignalRateLimitError(SignalSDKError):
    """Server-side rate limit hit (429). ``retry_after_ms`` is the
    minimum the caller should wait before re-sending."""

    def __init__(
        self,
        message: str,
        *,
        retry_after_ms: int | None = None,
        model_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.retry_after_ms = retry_after_ms
        self.model_id = model_id


class SignalServerError(SignalSDKError):
    """Generic 4xx/5xx rejection that doesn't fit the typed cases above."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        body: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class SignalTransportError(SignalSDKError):
    """Network/transport failure that exhausted the retry budget."""

    def __init__(
        self, message: str, *, last_error: BaseException | None = None
    ) -> None:
        super().__init__(message)
        self.last_error = last_error


__all__ = [
    "SignalAuthError",
    "SignalRateLimitError",
    "SignalSDKError",
    "SignalServerError",
    "SignalTransportError",
    "SignalValidationError",
]
