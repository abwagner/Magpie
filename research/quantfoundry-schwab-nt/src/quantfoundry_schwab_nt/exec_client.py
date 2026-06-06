"""Schwab Trader REST client for order operations + reconciliation.

Thin async wrapper around the `/trader/v1` order endpoints, authenticated
via :class:`SchwabAuthClient` (QF-161). Surfaces typed `SchwabOrder` /
`SchwabPosition` dataclasses for the NT adapter layer to map into NT's
own `Order` / `Position` types.

What's here (per QF-163 scope):

* `submit_order` — POST `/accounts/{hash}/orders`. Schwab returns 201 with
  a `Location` header carrying the new orderId.
* `cancel_order` — DELETE `/accounts/{hash}/orders/{orderId}`.
* `modify_order` — PUT `/accounts/{hash}/orders/{orderId}`. Schwab's
  REST is "cancel-then-resubmit under the hood"; the new orderId is in
  the response `Location` header. Race-tolerant: an already-FILLED
  order returns the original orderId unchanged.
* `query_order` — GET `/accounts/{hash}/orders/{orderId}`.
* `list_open_orders` — GET `/accounts/{hash}/orders?status=WORKING,...`.
  Used on startup reconciliation per the QF-160 spike's recommendation.
* `list_positions` — GET `/accounts/{hash}?fields=positions` — positions
  ride inside the account snapshot, not on a separate endpoint.

What's NOT here:

* NT `Order` / `Position` / `OrderStatusReport` types. The NT-bound
  glue ticket maps these dataclasses into NT types; this module stays
  NT-free so the unit tests can run without `nautilus_trader` installed.
* Order-state derivation — see :mod:`quantfoundry_schwab_nt.order_status`.
* Live exec-report stream — see :mod:`quantfoundry_schwab_nt.account_activity`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from quantfoundry_schwab_nt.auth import SchwabAuthClient

DEFAULT_TRADER_BASE = "https://api.schwabapi.com/trader/v1"

# Schwab's WORKING + AWAITING_* + PENDING_* statuses, in the
# canonical comma-separated form Schwab's `/orders?status=...`
# filter expects. `status` is single-value in Schwab's REST API
# (despite NT's mental model of "open orders"), so the reconciliation
# path issues one request per status and merges client-side.
_OPEN_ORDER_STATUSES: tuple[str, ...] = (
    "WORKING",
    "ACCEPTED",
    "QUEUED",
    "PENDING_ACTIVATION",
    "PENDING_ACKNOWLEDGEMENT",
    "PENDING_CANCEL",
    "PENDING_REPLACE",
    "AWAITING_PARENT_ORDER",
    "AWAITING_CONDITION",
    "AWAITING_STOP_CONDITION",
    "AWAITING_MANUAL_REVIEW",
    "AWAITING_RELEASE_TIME",
)


# ── Dataclasses ───────────────────────────────────────────────────


@dataclass
class SchwabOrder:
    """Subset of the Schwab order shape the NT adapter cares about.

    Untyped fields ride along in :attr:`raw` so the adapter can fish
    out anything not represented here without re-fetching.
    """

    order_id: str
    account_hash: str
    status: str  # raw Schwab status; convert via order_status.derive_order_status
    quantity: float
    filled_quantity: float
    # Schwab's leg-level encoding: each leg has an instrument + instruction
    # (BUY, SELL, BUY_TO_OPEN, etc.) + quantity. Single-leg orders have
    # exactly one entry; multi-leg / complex orders have N.
    legs: list[dict[str, Any]] = field(default_factory=list)
    replaced_order_id: str | None = None  # set on the NEW order after a replace
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class SchwabPosition:
    """Account-level position read from `/accounts/{hash}?fields=positions`."""

    account_hash: str
    instrument_symbol: str
    instrument_type: str  # OPTION / EQUITY / FUTURE / FUTURE_OPTION
    long_quantity: float
    short_quantity: float
    market_value: float
    average_price: float
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def net_quantity(self) -> float:
        """Positive=net long, negative=net short."""
        return self.long_quantity - self.short_quantity


class SchwabExecError(Exception):
    """Raised on non-success Schwab REST responses (not 401 — that's
    refresh-and-retry, handled inside :class:`SchwabAuthClient`)."""

    def __init__(self, message: str, *, status_code: int, body: Any) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


# ── Client ────────────────────────────────────────────────────────


class SchwabRestExecClient:
    """REST exec client. One instance per account; cheap to construct.

    The account hash (NOT the plain account number) is the path
    parameter Schwab uses; get it from `/accounts/accountNumbers`.
    """

    def __init__(
        self,
        *,
        auth_client: SchwabAuthClient,
        account_hash: str,
        trader_base: str = DEFAULT_TRADER_BASE,
    ) -> None:
        self._auth = auth_client
        self._account_hash = account_hash
        self._base = trader_base.rstrip("/")

    @property
    def account_hash(self) -> str:
        return self._account_hash

    # ── Order ops ────────────────────────────────────────────────

    async def submit_order(self, body: dict[str, Any]) -> str:
        """POST a new order. Returns the Schwab orderId.

        ``body`` is the full Schwab order JSON — caller composes it
        from the higher-level intent. Single-leg simple orders and
        multi-leg complex orders use the same endpoint with different
        ``complexOrderStrategyType`` + ``orderLegCollection`` shapes.
        """
        url = f"{self._base}/accounts/{self._account_hash}/orders"
        resp = await self._auth.post(url, json=body)
        if resp.status_code != 201:
            raise SchwabExecError(
                f"submit_order failed: HTTP {resp.status_code}",
                status_code=resp.status_code,
                body=_safe_body(resp),
            )
        return _order_id_from_location(resp)

    async def cancel_order(self, order_id: str) -> None:
        """DELETE an order. Idempotent: cancelling a completed order
        returns the order's terminal state, not a 4xx."""
        url = f"{self._base}/accounts/{self._account_hash}/orders/{order_id}"
        resp = await self._auth.delete(url)
        # Schwab returns 200 with the latest order body OR 200 No Content.
        # 4xx is a real failure.
        if resp.status_code >= 400:
            raise SchwabExecError(
                f"cancel_order failed: HTTP {resp.status_code}",
                status_code=resp.status_code,
                body=_safe_body(resp),
            )

    async def modify_order(self, order_id: str, body: dict[str, Any]) -> str:
        """PUT a replacement. Returns the NEW orderId.

        Schwab's PUT is cancel+resubmit under the hood. The new
        orderId comes back in the response `Location` header. If
        Schwab returns 200 with no Location (race: original order
        filled mid-flight), we surface the original orderId — the
        NT adapter ticket maps that to a no-op replace event.
        """
        url = f"{self._base}/accounts/{self._account_hash}/orders/{order_id}"
        resp = await self._auth.put(url, json=body)
        if resp.status_code >= 400:
            raise SchwabExecError(
                f"modify_order failed: HTTP {resp.status_code}",
                status_code=resp.status_code,
                body=_safe_body(resp),
            )
        new_id = _maybe_order_id_from_location(resp)
        return new_id or order_id

    async def query_order(self, order_id: str) -> SchwabOrder:
        """GET a single order by id."""
        url = f"{self._base}/accounts/{self._account_hash}/orders/{order_id}"
        resp = await self._auth.get(url)
        if resp.status_code >= 400:
            raise SchwabExecError(
                f"query_order failed: HTTP {resp.status_code}",
                status_code=resp.status_code,
                body=_safe_body(resp),
            )
        return _parse_order(resp.json(), account_hash=self._account_hash)

    # ── Reconciliation reads ─────────────────────────────────────

    async def list_open_orders(self) -> list[SchwabOrder]:
        """Pull every order in any open Schwab status.

        Schwab's `/orders?status=X` is single-status; we issue one
        request per status and merge. Empty-status results are
        common and don't raise.
        """
        out: list[SchwabOrder] = []
        seen_ids: set[str] = set()
        for status in _OPEN_ORDER_STATUSES:
            url = f"{self._base}/accounts/{self._account_hash}/orders"
            resp = await self._auth.get(url, params={"status": status})
            if resp.status_code >= 400:
                raise SchwabExecError(
                    f"list_open_orders({status}) failed: HTTP {resp.status_code}",
                    status_code=resp.status_code,
                    body=_safe_body(resp),
                )
            body = resp.json()
            if not isinstance(body, list):
                continue
            for item in body:
                if not isinstance(item, dict):
                    continue
                parsed = _parse_order(item, account_hash=self._account_hash)
                if parsed.order_id in seen_ids:
                    continue
                seen_ids.add(parsed.order_id)
                out.append(parsed)
        return out

    async def list_positions(self) -> list[SchwabPosition]:
        """Pull positions from the account snapshot.

        Schwab returns positions inside the account body when the
        ``?fields=positions`` query is set.
        """
        url = f"{self._base}/accounts/{self._account_hash}"
        resp = await self._auth.get(url, params={"fields": "positions"})
        if resp.status_code >= 400:
            raise SchwabExecError(
                f"list_positions failed: HTTP {resp.status_code}",
                status_code=resp.status_code,
                body=_safe_body(resp),
            )
        body = resp.json()
        # Schwab wraps the account in {"securitiesAccount": {...}}.
        acct = body.get("securitiesAccount", body) if isinstance(body, dict) else {}
        positions_raw = acct.get("positions") if isinstance(acct, dict) else None
        if not isinstance(positions_raw, list):
            return []
        return [
            _parse_position(p, account_hash=self._account_hash)
            for p in positions_raw
            if isinstance(p, dict)
        ]


# ── Parsing helpers ───────────────────────────────────────────────


def _order_id_from_location(resp: httpx.Response) -> str:
    loc = resp.headers.get("location") or resp.headers.get("Location")
    if not loc:
        raise SchwabExecError(
            "submit_order succeeded but Location header missing",
            status_code=resp.status_code,
            body=_safe_body(resp),
        )
    # Location format: ".../accounts/{hash}/orders/{orderId}"
    return str(loc).rstrip("/").rsplit("/", 1)[-1]


def _maybe_order_id_from_location(resp: httpx.Response) -> str | None:
    loc = resp.headers.get("location") or resp.headers.get("Location")
    if not loc:
        return None
    return str(loc).rstrip("/").rsplit("/", 1)[-1]


def _parse_order(raw: dict[str, Any], *, account_hash: str) -> SchwabOrder:
    order_id = str(raw.get("orderId") or "")
    status = str(raw.get("status") or "UNKNOWN")
    quantity = float(raw.get("quantity") or 0.0)
    filled_quantity = float(raw.get("filledQuantity") or 0.0)
    legs_raw = raw.get("orderLegCollection") or []
    legs = [leg for leg in legs_raw if isinstance(leg, dict)]
    replaced = raw.get("replacedOrderId")
    return SchwabOrder(
        order_id=order_id,
        account_hash=account_hash,
        status=status,
        quantity=quantity,
        filled_quantity=filled_quantity,
        legs=legs,
        replaced_order_id=str(replaced) if replaced else None,
        raw=raw,
    )


def _parse_position(raw: dict[str, Any], *, account_hash: str) -> SchwabPosition:
    instr = raw.get("instrument") or {}
    return SchwabPosition(
        account_hash=account_hash,
        instrument_symbol=str(instr.get("symbol") or ""),
        instrument_type=str(instr.get("assetType") or ""),
        long_quantity=float(raw.get("longQuantity") or 0.0),
        short_quantity=float(raw.get("shortQuantity") or 0.0),
        market_value=float(raw.get("marketValue") or 0.0),
        average_price=float(raw.get("averagePrice") or 0.0),
        raw=raw,
    )


def _safe_body(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:
        try:
            return resp.text
        except Exception:
            return None


__all__ = [
    "SchwabExecError",
    "SchwabOrder",
    "SchwabPosition",
    "SchwabRestExecClient",
]
