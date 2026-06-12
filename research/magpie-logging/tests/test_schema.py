"""Schema and propagation tests for ``magpie_logging``.

Covers:
- the framework schema fields (ts / level / service / correlation_id / event / payload)
- with_correlation_id ContextVar propagation, including nesting
- synthetic NATS-style header round-trip
- synthetic HTTP-style header round-trip
"""

from __future__ import annotations

import asyncio
import io
import json
from contextlib import redirect_stdout

import structlog
from magpie_logging import (
    current_correlation_id,
    get_logger,
    with_correlation_id,
)


def _capture_one_line() -> dict[str, object]:
    """Capture stdout for a single ``logger.info(...)`` call and return the
    parsed JSON dict."""
    # Tests share global structlog state; reset between cases so each test
    # sees a clean processor chain. cache_logger_on_first_use means we have
    # to invalidate after reconfigure too.
    structlog.reset_defaults()
    import magpie_logging  # local import to flip the configured flag

    magpie_logging._configured = False
    buf = io.StringIO()
    with redirect_stdout(buf):
        logger = get_logger("test-service")
        with with_correlation_id("01TESTCORRELATION12345ABCD"):
            logger.info("test.smoke", k="v", n=42)
    line = buf.getvalue().strip()
    return json.loads(line)


def test_schema_has_required_fields() -> None:
    parsed = _capture_one_line()
    assert parsed["level"] == "info"
    assert parsed["service"] == "test-service"
    assert parsed["correlation_id"] == "01TESTCORRELATION12345ABCD"
    assert parsed["event"] == "test.smoke"
    assert parsed["payload"] == {"k": "v", "n": 42}
    assert isinstance(parsed["ts"], str)
    assert "T" in parsed["ts"]
    assert parsed["ts"].endswith("Z")


def test_field_order_matches_framework() -> None:
    parsed = _capture_one_line()
    # JSON dicts preserve insertion order in Python 3.7+; the renderer
    # emits in framework order.
    assert list(parsed.keys()) == [
        "ts",
        "level",
        "service",
        "correlation_id",
        "event",
        "payload",
    ]


def test_correlation_id_omitted_without_context() -> None:
    structlog.reset_defaults()
    import magpie_logging

    magpie_logging._configured = False
    buf = io.StringIO()
    with redirect_stdout(buf):
        logger = get_logger("test-service")
        logger.info("test.no_context")
    parsed = json.loads(buf.getvalue().strip())
    assert "correlation_id" not in parsed


def test_with_correlation_id_round_trips() -> None:
    assert current_correlation_id() is None
    with with_correlation_id("01OUTER000000000000000000A"):
        assert current_correlation_id() == "01OUTER000000000000000000A"
    assert current_correlation_id() is None


def test_with_correlation_id_nests_and_restores() -> None:
    with with_correlation_id("outer"):
        with with_correlation_id("inner"):
            assert current_correlation_id() == "inner"
        assert current_correlation_id() == "outer"


def test_correlation_id_survives_await_boundary() -> None:
    """ContextVar (unlike a thread-local) propagates across ``await`` points.
    This test confirms the async-safety claim the helper makes."""

    async def inner() -> str | None:
        # Yield once so we cross an await boundary.
        await asyncio.sleep(0)
        return current_correlation_id()

    async def runner() -> str | None:
        with with_correlation_id("01ASYNC000000000000000000A"):
            return await inner()

    assert asyncio.run(runner()) == "01ASYNC000000000000000000A"


# ── Synthetic propagation hops ────────────────────────────────────────────


def test_synthetic_nats_hop_propagates_via_header() -> None:
    """Stand-in for a real NATS round-trip: publisher writes the correlation
    ID to the ``X-Correlation-Id`` header (observability.md §4.2); subscriber
    reads the header and binds it on the handler side. Asserts the bound
    value matches what was published."""

    class FakeMessage:
        def __init__(self) -> None:
            self.headers: dict[str, str] = {}

    msg = FakeMessage()

    # Publisher side: assume we're already in a with_correlation_id block
    with with_correlation_id("01NATSPUBLISHED000000000A"):
        # The framework's `publish_with_context` wrapper would set this.
        cid = current_correlation_id()
        assert cid is not None
        msg.headers["X-Correlation-Id"] = cid

    # Subscriber side: handler reads header, binds context, asserts.
    inbound_cid = msg.headers.get("X-Correlation-Id")
    assert inbound_cid is not None
    with with_correlation_id(inbound_cid):
        assert current_correlation_id() == "01NATSPUBLISHED000000000A"


def test_synthetic_http_hop_propagates_via_header() -> None:
    """Stand-in for an HTTP round-trip: outbound client sets
    ``X-Correlation-Id``; inbound handler reads it and binds context."""

    class FakeRequest:
        def __init__(self) -> None:
            self.headers: dict[str, str] = {}

    req = FakeRequest()

    with with_correlation_id("01HTTPOUTBOUND00000000000A"):
        cid = current_correlation_id()
        assert cid is not None
        req.headers["X-Correlation-Id"] = cid

    # Inbound side: handler binds the header value.
    inbound_cid = req.headers.get("X-Correlation-Id")
    assert inbound_cid is not None
    with with_correlation_id(inbound_cid):
        assert current_correlation_id() == "01HTTPOUTBOUND00000000000A"
