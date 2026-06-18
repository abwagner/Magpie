"""IBKR NT bridge launcher (QF-364) — iteration 1: connectivity.

The IBKR bridge (QF-353) shipped its message-handling logic + the
``IbkrSessionClient`` Protocol + body translators, all tested against a
fake session — but the concrete NT-backed pieces that actually talk to IB
Gateway were never written. This module is the first live increment: it
builds a NautilusTrader ``TradingNode`` wired to IB Gateway and runs it, so
we can confirm the connection handshake + instrument provider before adding
order submission (the in-node bridge ``Strategy`` + concrete session) and
the combo BAG path.

Run (paper gateway on 127.0.0.1:4002):

    cd research && uv run python -m magpie_ibkr_nt.run_bridge

Env:
  IBG_HOST       IB Gateway host (default 127.0.0.1)
  IBG_PORT       IB Gateway port (default 4002 = paper IBG)
  IBG_CLIENT_ID  IB API client id (default 1)
  IB_ACCOUNT     IB account id (e.g. DU1234567). Falls back to NT's
                 TWS_ACCOUNT env var when unset.

NOTE: iteration 1 only builds + connects the node. Order submission (the
bridge Strategy + the concrete IbkrSessionClient + connect_and_run wiring)
and the combo BAG path land in the next increments — see memory
nt-ibkr-live-integration.
"""

from __future__ import annotations

import os

from nautilus_trader.adapters.interactive_brokers.config import (
    InteractiveBrokersDataClientConfig,
    InteractiveBrokersExecClientConfig,
    InteractiveBrokersInstrumentProviderConfig,
)
from nautilus_trader.adapters.interactive_brokers.factories import (
    InteractiveBrokersLiveDataClientFactory,
    InteractiveBrokersLiveExecClientFactory,
)
from nautilus_trader.config import LoggingConfig, TradingNodeConfig
from nautilus_trader.live.node import TradingNode

IB = "IB"


def _int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value else default


def build_node() -> TradingNode:
    """Build a TradingNode wired to IB Gateway for order execution.

    A shared instrument-provider config (empty load set — contracts are
    qualified on demand at order time) backs both clients. The exec client
    is what we need for orders; the data client is included so contract
    details / qualification round-trips have a home.
    """
    host = os.getenv("IBG_HOST", "127.0.0.1")
    port = _int_env("IBG_PORT", 4002)
    client_id = _int_env("IBG_CLIENT_ID", 1)
    account_id = os.getenv("IB_ACCOUNT")  # None → NT falls back to TWS_ACCOUNT

    provider = InteractiveBrokersInstrumentProviderConfig()

    config = TradingNodeConfig(
        trader_id="MAGPIE-IBKR-001",
        logging=LoggingConfig(log_level="INFO"),
        data_clients={
            IB: InteractiveBrokersDataClientConfig(
                ibg_host=host,
                ibg_port=port,
                ibg_client_id=client_id,
                instrument_provider=provider,
            ),
        },
        exec_clients={
            IB: InteractiveBrokersExecClientConfig(
                ibg_host=host,
                ibg_port=port,
                ibg_client_id=client_id,
                account_id=account_id,
                instrument_provider=provider,
            ),
        },
    )

    node = TradingNode(config=config)
    node.add_data_client_factory(IB, InteractiveBrokersLiveDataClientFactory)
    node.add_exec_client_factory(IB, InteractiveBrokersLiveExecClientFactory)
    node.build()
    return node


def main() -> None:
    node = build_node()
    try:
        node.run()
    except KeyboardInterrupt:
        pass
    finally:
        node.dispose()


if __name__ == "__main__":
    # NT's TradingNode.run() manages its own event loop; guard against an
    # already-running loop only matters under embedding, which we don't do.
    try:
        main()
    except RuntimeError as e:  # pragma: no cover - surfaced live
        raise SystemExit(f"IBKR bridge failed to start: {e}") from e


__all__ = ["build_node", "main"]
