"""Smoke tests for the quantfoundry-md-bridge package skeleton (M13-02).

These tests verify the package installs cleanly and the runtime imports
expected by downstream M13 tickets succeed. They do not exercise behavior —
that lives in the per-bridge tests added by M13-05 (Schwab) and M13-06 (IBKR).
"""

from __future__ import annotations


def test_package_importable() -> None:
    """Top-level package imports."""
    import quantfoundry_md_bridge

    assert quantfoundry_md_bridge.__doc__ is not None


def test_subpackages_importable() -> None:
    """Schwab + IBKR subpackages are importable stubs."""
    from quantfoundry_md_bridge import ibkr, schwab

    # Stubs ship only docstrings until M13-05 / M13-06 fill them in.
    assert schwab.__doc__ is not None
    assert ibkr.__doc__ is not None


def test_nautilus_trader_ib_adapter_available() -> None:
    """NT's IB DataClient config layer is reachable through this package's dep tree.

    M13-06 builds IbkrMdBridge on top of this; the smoke check confirms the
    `nautilus-trader[ib]` extras are installed (validated by the M13-01 spike).
    """
    from nautilus_trader.adapters.interactive_brokers.config import (
        InteractiveBrokersDataClientConfig,
    )

    # Construct with the same params the spike used.
    cfg = InteractiveBrokersDataClientConfig(
        ibg_host="127.0.0.1",
        ibg_port=4002,
        ibg_client_id=99,
        market_data_type=1,
    )
    assert cfg.ibg_host == "127.0.0.1"
    assert cfg.ibg_port == 4002
