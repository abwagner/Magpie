"""QF prod bundle launcher — config builder + hot-swap orchestrator (QF-326, QF-327).

One-TradingNode-per-broker architecture that co-hosts the QF bridge, risk-gate
plugin, and all enabled strategies for that broker (§4 of
docs/tdd/strategy-deployment-topology.md).

Main entry points:
  - ProdBundleLauncher: startup sequence (§4.2 steps 1-4)
  - HotSwapManager: NATS lifecycle event subscriber (§4.3, §8)
"""

from __future__ import annotations

from magpie_prod_bundle.hotswap import (
    HotSwapManager,
    TransitionEvent,
)
from magpie_prod_bundle.launcher import (
    BrokerConfigBuilder,
    BundleLoader,
    LauncherConfig,
    ProdBundleLauncher,
    RegistryClient,
    StrategyInfo,
)

__all__ = [
    "BrokerConfigBuilder",
    "BundleLoader",
    "HotSwapManager",
    "LauncherConfig",
    "ProdBundleLauncher",
    "RegistryClient",
    "StrategyInfo",
    "TransitionEvent",
]
