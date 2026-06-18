"""Shared IBKR NautilusTrader bootstrap (QF-365) — iteration 2.

Both IBKR bridges were shipped as logic + a session class waiting on a
**shared NT TradingNode** that constructs the IB data + exec clients and is
injected into each bridge — and that bootstrap was never written. This is
it. It builds one node, connects it to IB Gateway, and runs it alongside
the IBKR **market-data** bridge (``magpie_md_bridge.ibkr.__main__.amain``)
in a single event loop.

Iteration 2 scope: shared node + MD bridge wiring. This proves the node
connects to the gateway and the MD bridge subscribes to its
``marketdata.rpc.*.ibkr`` NATS subjects. The ``NtIbkrMdSession`` data
methods (get_quote / get_chain / get_expirations) are still
``NotImplementedError`` — they're the next increment, filled in live
against the gateway (see memory nt-ibkr-live-integration). The broker
bridge (orders/positions) wiring is iteration 3.

Run (paper gateway on 127.0.0.1:4002, NATS up):

    cd research && uv run python -m magpie_prod_bundle.ibkr_bootstrap

Env: IBG_HOST (127.0.0.1), IBG_PORT (4002), IBG_CLIENT_ID (1),
     IB_ACCOUNT (or NT's TWS_ACCOUNT), NATS_URL (nats://localhost:4222).
"""

from __future__ import annotations

import asyncio
import contextlib
import os

from magpie_md_bridge.ibkr.__main__ import amain as md_amain
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
    """Build the shared TradingNode with IB data + exec clients.

    One instrument-provider config backs both clients (contracts qualified
    on demand). Validated to construct + reach READY against
    nautilus_trader 1.227.0; the connection itself happens at run.
    """
    host = os.getenv("IBG_HOST", "127.0.0.1")
    port = _int_env("IBG_PORT", 4002)
    client_id = _int_env("IBG_CLIENT_ID", 1)
    account_id = os.getenv("IB_ACCOUNT")  # None → NT falls back to TWS_ACCOUNT
    provider = InteractiveBrokersInstrumentProviderConfig()

    # The exec client requires an IB account id (NT asserts it). Iteration 2
    # is market-data only, so only wire the exec client when an account is
    # available (IB_ACCOUNT or NT's TWS_ACCOUNT) — otherwise build a
    # data-only node so the MD path runs without a paper-account login.
    has_account = bool(account_id or os.getenv("TWS_ACCOUNT"))
    exec_clients = (
        {
            IB: InteractiveBrokersExecClientConfig(
                ibg_host=host,
                ibg_port=port,
                ibg_client_id=client_id,
                account_id=account_id,
                instrument_provider=provider,
            ),
        }
        if has_account
        else {}
    )
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
        exec_clients=exec_clients,
    )
    node = TradingNode(config=config)
    node.add_data_client_factory(IB, InteractiveBrokersLiveDataClientFactory)
    if exec_clients:
        node.add_exec_client_factory(IB, InteractiveBrokersLiveExecClientFactory)
    node.build()
    return node


async def amain() -> None:
    node = build_node()
    node_task = asyncio.create_task(node.run_async())
    try:
        # The MD bridge connects to NATS and serves marketdata.rpc.*.ibkr
        # against the shared node's data client, running until cancelled.
        await md_amain(trading_node=node)
    finally:
        await node.stop_async()
        node.dispose()
        node_task.cancel()


def main() -> None:
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(amain())


if __name__ == "__main__":
    main()


__all__ = ["build_node", "amain", "main"]
