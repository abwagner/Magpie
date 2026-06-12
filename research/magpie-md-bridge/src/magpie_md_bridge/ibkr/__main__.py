"""Entrypoint for the IBKR MD bridge service.

Wires a shared NT `TradingNode` + `NtIbkrMdSession` + `IbkrMdBridge`. Per
TDD §7, this process is **also** the home for QF-240's `IbkrBrokerBridge`
(order observer) so they share the single IB Gateway TWS-API client.

In v1 the actual NT runtime composition (constructing the TradingNode,
registering DataClient + ExecutionClient, wiring MessageBus into the
order observer + MD bridge) is operator-led: this module exposes
``amain()`` as the inner loop, but the production deployment is expected
to build the TradingNode in a shared bootstrap script that imports both
``magpie_md_bridge.ibkr.IbkrMdBridge`` AND
``magpie_ibkr_nt.broker_bridge.IbkrBrokerBridge`` and feeds them
the same node.

Env vars consumed:
- ``NATS_URL`` (default ``nats://localhost:4222``)
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from typing import Any, cast

from .bridge import IbkrMdBridge
from .nt_session import NtIbkrMdSession

logger = logging.getLogger(__name__)


async def amain(*, trading_node: Any | None = None) -> None:
    """Run the IBKR MD bridge.

    `trading_node` is the shared NT `TradingNode` (registered with one
    `InteractiveBrokersDataClient` + one `InteractiveBrokersExecutionClient`).
    When `None`, the function raises rather than constructing one — the
    deployment-time bootstrap is responsible for that wiring.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if trading_node is None:
        raise RuntimeError(
            "ibkr-md-bridge requires a shared NT TradingNode injected by the "
            "process bootstrap (per docs/tdd/market-data-via-nt.md §7). "
            "Construct the node + register DataClient/ExecutionClient + pass "
            "the node here."
        )

    nats_url = os.environ.get("NATS_URL", "nats://localhost:4222")

    import nats

    nc = await nats.connect(nats_url)
    logger.info("connected to NATS at %s", nats_url)

    session = NtIbkrMdSession(trading_node=trading_node)
    bridge = IbkrMdBridge(nats=cast(Any, nc), session=session)
    await bridge.start()
    logger.info("ibkr-md-bridge: started")

    stop_event = asyncio.Event()

    def _on_signal(*_: object) -> None:
        logger.info("ibkr-md-bridge: signal received, stopping")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for s in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(s, _on_signal)

    try:
        await stop_event.wait()
    finally:
        await bridge.stop()
        await nc.drain()
        logger.info("ibkr-md-bridge: stopped")
