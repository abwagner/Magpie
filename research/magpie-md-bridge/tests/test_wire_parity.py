"""JSON parity tests for the MD-bridge wire format (M13-03).

Each fixture under ``tests/fixtures/wire/`` is the source-of-truth example
for one TS type from ``src/types/market-data.ts`` (or one RPC envelope from
``docs/tdd/market-data-via-nt.md`` §3.2). For each fixture, parse → dump →
re-parse must produce the same canonical dict — catches drift between the
TS shapes and the Python mirrors at refactor time.

TS-side parity tests (M13-04 ships in ``server/market-data/adapters/__tests__/``)
parse the same fixtures and assert identical round-trip behavior.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from magpie_md_bridge.wire import (
    Candle,
    CandlesReply,
    CandlesRequest,
    ChainReply,
    ChainRequest,
    Contract,
    DataMeta,
    ErrorFrame,
    ExpirationsReply,
    Heartbeat,
    HistoricalChainReply,
    HistoricalChainRequest,
    L2Book,
    L2Level,
    Quote,
    QuoteReply,
    QuoteRequest,
    TradePrint,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "wire"


def _load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES_DIR / f"{name}.json").read_text())


@dataclass(frozen=True)
class _ParitySpec:
    fixture: str
    from_dict: Callable[[dict[str, Any]], Any]


SPECS: list[_ParitySpec] = [
    _ParitySpec("quote", Quote.from_dict),
    _ParitySpec("contract", Contract.from_dict),
    _ParitySpec("trade_print", TradePrint.from_dict),
    _ParitySpec("l2_book", L2Book.from_dict),
    _ParitySpec("candle", Candle.from_dict),
    _ParitySpec("quote_request", QuoteRequest.from_dict),
    _ParitySpec("chain_request", ChainRequest.from_dict),
    _ParitySpec("historical_chain_request", HistoricalChainRequest.from_dict),
    _ParitySpec("candles_request", CandlesRequest.from_dict),
    _ParitySpec("quote_reply_ok", QuoteReply.from_dict),
    _ParitySpec("quote_reply_error", QuoteReply.from_dict),
    _ParitySpec("expirations_reply", ExpirationsReply.from_dict),
    _ParitySpec("heartbeat", Heartbeat.from_dict),
]


def test_every_fixture_round_trips() -> None:
    """parse → dump → parse-again must be a no-op."""
    for spec in SPECS:
        raw = _load(spec.fixture)
        parsed = spec.from_dict(raw)
        dumped = parsed.to_dict()
        re_parsed = spec.from_dict(dumped)
        assert parsed == re_parsed, (
            f"{spec.fixture}: round trip is not idempotent\n"
            f"  parsed   = {parsed}\n"
            f"  dumped   = {dumped}\n"
            f"  re-parsed= {re_parsed}"
        )


def test_quote_meta_field_mapping() -> None:
    """`_meta` in JSON maps to `meta` on the dataclass — verify both directions."""
    raw = _load("quote")
    q = Quote.from_dict(raw)
    assert q.meta.source == "schwab"
    out = q.to_dict()
    assert "_meta" in out
    assert "meta" not in out


def test_chain_reply_with_payload() -> None:
    """A chain reply with multiple contracts round-trips cleanly."""
    contract_d = _load("contract")
    payload = {"chain": [contract_d, dict(contract_d, strike=520.0)]}
    parsed = ChainReply.from_dict(payload)
    assert parsed.chain is not None
    assert len(parsed.chain) == 2
    assert parsed.chain[1].strike == 520.0
    re_parsed = ChainReply.from_dict(parsed.to_dict())
    assert parsed == re_parsed


def test_historical_chain_reply_error_frame() -> None:
    """not_supported error envelope round-trips (Schwab historical chain case)."""
    payload = {
        "error": {
            "code": "not_supported",
            "message": "Schwab REST does not expose historical chain endpoints",
        }
    }
    parsed = HistoricalChainReply.from_dict(payload)
    assert parsed.chain is None
    assert parsed.error is not None
    assert parsed.error.code == "not_supported"
    re_parsed = HistoricalChainReply.from_dict(parsed.to_dict())
    assert parsed == re_parsed


def test_candles_reply_empty_list() -> None:
    """An empty candles list is distinct from a None payload."""
    payload = {"candles": []}
    parsed = CandlesReply.from_dict(payload)
    assert parsed.candles == ()
    assert parsed.error is None
    re_parsed = CandlesReply.from_dict(parsed.to_dict())
    assert parsed == re_parsed


def test_candles_request_keyword_field_mapping() -> None:
    """TS `from`/`to` keywords map to fromDate/toDate on the Python dataclass."""
    raw = _load("candles_request")
    parsed = CandlesRequest.from_dict(raw)
    assert parsed.fromDate == "2026-05-15"
    assert parsed.toDate == "2026-05-20"
    out = parsed.to_dict()
    assert out["from"] == "2026-05-15"
    assert out["to"] == "2026-05-20"
    assert "fromDate" not in out


def test_error_frame_rejects_unknown_code() -> None:
    """ErrorFrame validates the code against the documented enum."""
    import pytest

    with pytest.raises(ValueError, match="unknown value 'invalid_code'"):
        ErrorFrame.from_dict({"code": "invalid_code", "message": "x"})


def test_data_meta_optional_fields() -> None:
    """source_timestamp and freshness_ms can be null and survive round-trip."""
    raw = {
        "source": "ibkr",
        "source_timestamp": None,
        "fetched_at": "2026-05-20T18:30:00Z",
        "freshness_ms": None,
        "latency_ms": 12.5,
        "from_cache": False,
        "cache_age_ms": 0,
        "sources_tried": ["ibkr"],
    }
    parsed = DataMeta.from_dict(raw)
    assert parsed.source_timestamp is None
    assert parsed.freshness_ms is None
    re_parsed = DataMeta.from_dict(parsed.to_dict())
    assert parsed == re_parsed


def test_l2_level_with_and_without_num_orders() -> None:
    """num_orders is optional — present + absent must both round-trip."""
    with_orders = {"price": 100.0, "size": 50, "num_orders": 3}
    without = {"price": 100.0, "size": 50}
    assert L2Level.from_dict(with_orders).num_orders == 3
    assert L2Level.from_dict(without).num_orders is None
    # Re-dump should preserve the distinction.
    assert "num_orders" in L2Level.from_dict(with_orders).to_dict()
    assert "num_orders" not in L2Level.from_dict(without).to_dict()
