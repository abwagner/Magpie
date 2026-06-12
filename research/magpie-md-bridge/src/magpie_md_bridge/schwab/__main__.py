"""Entrypoint for the Schwab MD bridge service.

Wires `SchwabAuthClient` + `SchwabRestMdClient` + `SchwabMdBridge` together
and runs the bridge until SIGTERM. Designed to run under systemd
(`systemd/schwab-md-bridge.service`) on the credential host.

Env vars consumed:
- ``NATS_URL`` (default ``nats://localhost:4222``)
- ``SCHWAB_TOKEN_STORE_PATH`` (default ``/var/lib/magpie/schwab-tokens.json``)
- Schwab auth secrets — same env contract as ``magpie_schwab_nt.auth``:
  ``SCHWAB_APP_KEY``, ``SCHWAB_APP_SECRET``.

Run::

    uv run --package magpie-md-bridge \\
        python -m magpie_md_bridge.schwab
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from pathlib import Path
from typing import Any, cast

from magpie_schwab_nt.auth import SchwabAuthClient, SchwabTokenStore

from .bridge import SchwabMdBridge
from .rest_md_client import SchwabRestMdClient

logger = logging.getLogger(__name__)


async def amain() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    nats_url = os.environ.get("NATS_URL", "nats://localhost:4222")
    token_store_path = Path(
        os.environ.get(
            "SCHWAB_TOKEN_STORE_PATH",
            "/var/lib/magpie/schwab-tokens.json",
        )
    )

    # NATS dependency is loaded lazily so the unit tests of the bridge
    # (which use a fake NATS) don't pay the import cost.
    import nats

    nc = await nats.connect(nats_url)
    logger.info("connected to NATS at %s", nats_url)

    app_key = os.environ["SCHWAB_APP_KEY"]
    app_secret = os.environ["SCHWAB_APP_SECRET"]
    token_store = SchwabTokenStore(
        app_key=app_key,
        app_secret=app_secret,
        store_path=token_store_path,
    )
    auth_client = SchwabAuthClient(token_store=token_store)
    rest = SchwabRestMdClient(auth_client=auth_client)
    # The real `nats.NatsClient` matches our _NatsClient Protocol
    # structurally; cast to satisfy strict mypy.
    bridge = SchwabMdBridge(nats=cast(Any, nc), rest=rest)
    await bridge.start()
    logger.info("schwab-md-bridge: started")

    stop_event = asyncio.Event()

    def _on_signal(*_: object) -> None:
        logger.info("schwab-md-bridge: signal received, stopping")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for s in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(s, _on_signal)

    try:
        await stop_event.wait()
    finally:
        await bridge.stop()
        await nc.drain()
        logger.info("schwab-md-bridge: stopped")


def main() -> None:
    asyncio.run(amain())


if __name__ == "__main__":
    main()
