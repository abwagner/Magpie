"""Schwab MD bridge.

The Python NATS service backing the QF TS server's nt-bridge-md adapter for
Schwab. No NT runtime (Schwab's streamer is bespoke per D3); reuses
``quantfoundry-schwab-nt``'s parsers, streamer client, and auth layer.

NATS subjects (per ``docs/tdd/market-data-via-nt.md`` §3.1):
- ``marketdata.rpc.{quote,expirations,chain,historical_chain,candles}.schwab``
- ``marketdata.{quotes,trades,book}.schwab.<SYMBOL>``
- ``marketdata.schwab.heartbeat``

Entry point: ``python -m quantfoundry_md_bridge.schwab`` (see ``__main__.py``).
systemd unit: ``research/quantfoundry-md-bridge/systemd/schwab-md-bridge.service``.
"""

from .bridge import SchwabMdBridge, subjects_for
from .rest_md_client import SchwabMdError, SchwabRestMdClient

__all__ = ["SchwabMdBridge", "SchwabMdError", "SchwabRestMdClient", "subjects_for"]
