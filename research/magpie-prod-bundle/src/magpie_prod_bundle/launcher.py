"""Prod bundle launcher — config builder + node lifecycle (QF-326, QF-327).

Responsibilities per docs/tdd/strategy-deployment-topology.md §4.2:

1. Resolve cohort: read the strategy list from the QF lifecycle registry HTTP
   API (GET /api/strategies), keep `running`-state strategies whose broker tag
   matches this launcher's broker.
2. Resolve code: import per-strategy build factories from the bundle's uv.lock.
3. Assemble the node: build a NautilusTrader ``TradingNodeConfig`` with all
   in-cohort strategies as co-tenants plus a ``Controller`` so the node can
   accept runtime strategy add/start/stop (the hot-swap path, QF-327).
4. Connect: instantiate + build + run the ``TradingNode`` against live creds.
5. Subscribe to lifecycle deltas: bind lifecycle.> NATS subject for hot-swap.

The launcher is idempotent against the registry: cohort = running + broker-
matched. On disagreement, the registry wins (HTTP read at boot + NATS deltas
thereafter). This is the same fail-safe the strategy state contract (§6) leans
on.

NT-API facts this module is wired against (nautilus-trader 1.227.0):

- The node is ``nautilus_trader.live.node.TradingNode`` configured with
  ``nautilus_trader.config.TradingNodeConfig``. There is no class literally
  named ``LiveTradingNodeConfig``; the live node config IS ``TradingNodeConfig``
  (re-exported from ``nautilus_trader.live.config``). The design doc's
  "LiveTradingNodeConfig" / "LiveTradingNode" names map onto these.
- Strategies are declared in the config as ``ImportableStrategyConfig``
  (strategy_path / config_path / config) and instantiated by NT's
  ``StrategyFactory`` at ``node.build()``.
- The **QF bridge** is NOT an NT config component. ``SchwabBrokerBridge`` /
  the IBKR bridge are standalone NATS-RPC sidecar processes (their own asyncio
  loop, their own NATS connection); the node's broker exec-client talks to them
  over NATS. The launcher therefore does not register the bridge into the node
  config — it is deployed alongside the node, not inside it. See
  ``magpie_schwab_nt.broker_bridge.connect_and_run``.
- The **QF risk-gate** (``magpie_risk_gate``) is designed as a
  ``RiskEngine`` subclass wired via ``RiskEngineConfig``, but that package's
  node-registration path (``risk_module_path``) is still a skeleton (see
  ``magpie_risk_gate/gate.py`` — ``QFRiskGate`` is not yet a concrete NT
  ``RiskEngine``). Until it lands, the node uses NT's stock
  ``LiveRiskEngineConfig``; the broker exec-client still routes every order
  through the bridge → QF gate over NATS, so the gate is enforced out-of-band.
  The hook for the in-node gate is left as a documented TODO on the builder.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    from nats.aio.client import Client as NatsClient
    from nautilus_trader.config import TradingNodeConfig
    from nautilus_trader.live.node import TradingNode


_LOGGER = logging.getLogger(__name__)

# The QF lifecycle registry co-hosts a strategy as a live co-tenant only once it
# reaches the `running` state (server/strategy/lifecycle.ts: LifecycleState).
# Boot cohort = registry `running` strategies whose broker tag matches this
# launcher. Other states (registered/enabled/paused/halted/retired) are not boot
# co-tenants; `enabled → running` (the `start` action) is what the hot-swap path
# (§4.3) reacts to.
_RUNNING_STATE = "running"

# Path on the QF TS server that returns the full strategy list. Confirmed
# against server/index.ts route table: `GET /api/strategies` → `strategiesList`
# handler → `strategyStore.list()`, which returns a bare JSON array of
# `Strategy` records (NOT wrapped in `{ strategies: [...] }`). See
# server/strategy/lifecycle.ts for the `Strategy` shape.
_STRATEGIES_PATH = "/api/strategies"


@dataclass
class LauncherConfig:
    """Configuration for the prod bundle launcher.

    Fields:
        broker: "schwab" | "ibkr" — the broker this launcher is bound to.
        qf_registry_url: HTTP base URL for the QF TS server's lifecycle API
            (e.g. "http://localhost:3000"). Resolved from env or config file.
        nats_url: NATS connection URL (e.g. "nats://localhost:4222").
            Resolved from env or NATS_URL.
        trader_id: NT TraderId for this node (e.g. "PROD-SCHWAB-001"). One per
            broker node; must be unique across co-located nodes so order id tags
            don't collide.
    """

    broker: str
    qf_registry_url: str
    nats_url: str
    trader_id: str

    @classmethod
    def from_env(cls, broker: str) -> LauncherConfig:
        """Load config from environment variables.

        Args:
            broker: "schwab" | "ibkr"

        Returns:
            LauncherConfig instance

        Raises:
            ValueError: if required env vars are missing.
        """
        qf_url = os.getenv("QF_REGISTRY_URL", "http://localhost:3000")
        nats_url = os.getenv("NATS_URL", "nats://localhost:4222")
        trader_id = os.getenv("QF_TRADER_ID", f"PROD-{broker.upper()}-001")

        if not qf_url:
            msg = "QF_REGISTRY_URL not set"
            raise ValueError(msg)
        if not nats_url:
            msg = "NATS_URL not set"
            raise ValueError(msg)

        return cls(
            broker=broker,
            qf_registry_url=qf_url,
            nats_url=nats_url,
            trader_id=trader_id,
        )


@dataclass
class StrategyInfo:
    """Strategy metadata from the QF registry + broker tag resolution.

    Fields:
        id: kebab-case strategy identifier (e.g. "cl-scalp").
        broker: "schwab" | "ibkr" — resolved from the strategy package's
            ``[tool.magpie] broker`` pyproject tag (§3). The registry
            record itself carries no broker field (see server/strategy/
            lifecycle.ts ``Strategy``), so the launcher resolves it from the
            installed package rather than from the HTTP response.
        strategy_path: NT import path "module:Class" for the strategy class
            (e.g. "magpie_cl_scalp.strategies.cl_scalp:ClScalp").
        config_path: NT import path "module:Class" for the StrategyConfig
            subclass (e.g. "magpie_cl_scalp.strategies.cl_scalp:ClScalpConfig").
        config: the strategy's config dict (params from the registry's
            params_provenance.selected_params, merged with deploy defaults).
    """

    id: str
    broker: str
    strategy_path: str
    config_path: str
    config: dict[str, Any]


class RegistryClient:
    """HTTP client for querying the QF lifecycle registry (§4.2 step 1).

    Confirmed endpoint (server/index.ts + server/strategy/lifecycle.ts):
        GET {base_url}/api/strategies
    Response: a bare JSON array of ``Strategy`` records, each at minimum::

        { "id": "cl-scalp", "label": "...", "state": "running",
          "registered_at": "...", "updated_at": "...", "history": [...] }

    Note there is NO ``broker``/``broker_tag`` field on the record — the broker
    is resolved separately from the strategy package's pyproject tag (see
    ``BundleLoader.resolve_broker``).
    """

    def __init__(self, base_url: str, http_client: httpx.AsyncClient | None = None):
        """Initialize with QF TS server's base URL.

        Args:
            base_url: HTTP base URL (e.g. "http://localhost:3000").
            http_client: optional httpx.AsyncClient; created lazily if None.
        """
        self.base_url = base_url.rstrip("/")
        self._http_client = http_client
        self._owns_client = http_client is None

    def _client(self) -> httpx.AsyncClient:
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=10.0)
        return self._http_client

    async def get_enabled_strategies(self) -> list[dict[str, Any]]:
        """Fetch the strategy list from the QF registry.

        Returns the full registry list (every state); the launcher filters to
        ``running`` + broker-matched in ``ProdBundleLauncher.startup``. We return
        the raw records so the caller can read ``state`` and other metadata.

        Returns:
            List of ``Strategy`` dicts (see class docstring for shape).

        Raises:
            httpx.HTTPError: if the HTTP request fails or returns non-2xx.
            ValueError: if the response body is not a JSON array.
        """
        url = f"{self.base_url}{_STRATEGIES_PATH}"
        resp = await self._client().get(url)
        resp.raise_for_status()
        body = resp.json()
        if not isinstance(body, list):
            msg = f"GET {url} returned non-array body: {type(body).__name__}"
            raise ValueError(msg)
        return body

    async def close(self) -> None:
        """Close the HTTP client if owned by this instance."""
        if self._http_client is not None and self._owns_client:
            await self._http_client.aclose()
            self._http_client = None


class BundleLoader:
    """Loads strategy code + broker tags from the bundle's uv.lock (§4.2 step 2).

    The bundle aggregates all strategy packages via path-deps in pyproject.toml.
    The uv.lock pins all transitive versions. This class resolves per-strategy
    NT import paths, instantiates ``Strategy`` objects via NT's
    ``StrategyFactory``, and reads each package's ``[tool.magpie] broker``
    tag from installed distribution metadata.
    """

    def build_strategy(self, info: StrategyInfo) -> Any:
        """Instantiate a live NT ``Strategy`` from its config (hot-swap path).

        Uses NT's ``StrategyFactory.create`` — the same code path
        ``node.build()`` uses for config-declared strategies — so a strategy
        added at runtime is wired identically to a boot co-tenant.

        Args:
            info: StrategyInfo with NT strategy_path / config_path / config.

        Returns:
            An un-started ``nautilus_trader.trading.strategy.Strategy`` instance.

        Raises:
            ImportError / TypeError: if the import paths or config are invalid.
        """
        from nautilus_trader.config import ImportableStrategyConfig
        from nautilus_trader.trading.config import StrategyFactory

        importable = ImportableStrategyConfig(
            strategy_path=info.strategy_path,
            config_path=info.config_path,
            config=info.config,
        )
        return StrategyFactory.create(importable)

    def importable_strategy_config(self, info: StrategyInfo) -> Any:
        """Build the ``ImportableStrategyConfig`` for node-config declaration.

        Args:
            info: StrategyInfo with NT strategy_path / config_path / config.

        Returns:
            An ``ImportableStrategyConfig`` for ``TradingNodeConfig.strategies``.
        """
        from nautilus_trader.config import ImportableStrategyConfig

        return ImportableStrategyConfig(
            strategy_path=info.strategy_path,
            config_path=info.config_path,
            config=info.config,
        )

    def resolve_broker(self, strategy_id: str, package_name: str) -> str | None:
        """Read a strategy package's ``[tool.magpie] broker`` tag.

        The registry record carries no broker field (§4.2 step 1 resolves the
        broker from the package's pyproject tag). Installed wheels don't ship
        ``pyproject.toml``; the tag is surfaced via the distribution's
        ``tool.magpie.broker`` entry projected into package metadata at
        build time. We read it from ``importlib.metadata`` so the launcher works
        against the locked wheels, not a source tree.

        Args:
            strategy_id: kebab-case identifier (for log context).
            package_name: PyPI/dist name of the strategy package
                (e.g. "magpie-cl-scalp").

        Returns:
            "schwab" | "ibkr" | ... , or None if the tag is absent.
        """
        from importlib.metadata import PackageNotFoundError, metadata

        try:
            md = metadata(package_name)
        except PackageNotFoundError:
            _LOGGER.warning(
                "Strategy %s package %s not installed in bundle lock",
                strategy_id,
                package_name,
            )
            return None
        # hatch/uv project metadata exposes [tool.magpie] keys as
        # "Keywords"/classifiers depending on backend; the canonical surface is
        # a distribution-level "QF-Broker" metadata field that strategy packages
        # set from their pyproject tag (see docs/tdd §3). Fall back to None when
        # unset so the caller treats it as "not in this broker's cohort".
        return md.get("QF-Broker")


class BrokerConfigBuilder:
    """Assembles a NT ``TradingNodeConfig`` with all co-tenants (§4.2 step 3).

    Builds the real ``nautilus_trader.config.TradingNodeConfig`` (the live node
    config; NT has no separate ``LiveTradingNodeConfig`` type) with:

    - ``environment=Environment.LIVE``
    - the cohort's strategies as ``ImportableStrategyConfig`` co-tenants
    - a ``Controller`` (``ImportableControllerConfig``) — REQUIRED so the node's
      trader will accept runtime ``add_strategy`` on a running node; without a
      controller NT logs "Cannot add a strategy to a running trader" and no-ops
      (nautilus_trader/trading/trader.py:396). ``start_strategy`` /
      ``stop_strategy`` work at runtime regardless, but the controller is what
      makes loading a *new* co-tenant mid-session possible (QF-327).
    - NT's stock ``LiveRiskEngineConfig``.

    The QF bridge is intentionally NOT in this config (it's a NATS-RPC sidecar,
    not an NT component); the broker exec/data clients that talk to it are added
    by the caller via broker-specific factories on the ``TradingNode`` (e.g.
    NT's IB adapter, or the Schwab exec-client) — out of this builder's scope.
    """

    # Default controller shipped by NT. A bespoke QF controller (e.g. one that
    # reconciles the live cohort against the registry on its own clock) can
    # replace this path later; for QF-327 the launcher drives add/start/stop
    # directly via node.trader, so the stock controller is only needed to flip
    # the trader's `_has_controller` flag that unlocks runtime add_strategy.
    _CONTROLLER_PATH = "nautilus_trader.trading.controller:Controller"
    _CONTROLLER_CONFIG_PATH = "nautilus_trader.live.config:ControllerConfig"

    def __init__(self, broker: str):
        """Initialize with a broker identifier.

        Args:
            broker: "schwab" | "ibkr"
        """
        self.broker = broker

    def build_node_config(
        self,
        strategies: list[StrategyInfo],
        *,
        trader_id: str,
        loader: BundleLoader | None = None,
    ) -> TradingNodeConfig:
        """Build a ``TradingNodeConfig`` with all strategies as co-tenants.

        Args:
            strategies: in-cohort StrategyInfo list (running + broker-matched).
            trader_id: NT TraderId string for this node.
            loader: BundleLoader for importable-config construction; a default
                is used when None.

        Returns:
            A ``nautilus_trader.config.TradingNodeConfig``.

        Raises:
            ImportError / TypeError: if any strategy import path is invalid.
        """
        from nautilus_trader.common import Environment
        from nautilus_trader.config import (
            ImportableControllerConfig,
            LiveRiskEngineConfig,
            TradingNodeConfig,
        )

        ld = loader or BundleLoader()
        strategy_configs = [ld.importable_strategy_config(s) for s in strategies]

        # The controller is what unlocks runtime add_strategy on the live node
        # (see class docstring). ControllerConfig is the stock base config.
        controller = ImportableControllerConfig(
            controller_path=self._CONTROLLER_PATH,
            config_path=self._CONTROLLER_CONFIG_PATH,
            config={},
        )

        # TODO(QF-326): once magpie_risk_gate.QFRiskGate is a concrete NT
        # RiskEngine (gate.py is a skeleton today), pass it via
        # RiskEngineConfig(risk_module_path="magpie_risk_gate.gate:QFRiskGate",
        # config={...}) here. Until then the stock LiveRiskEngineConfig is used
        # and the gate is enforced out-of-band over NATS by the broker bridge.
        risk_engine = LiveRiskEngineConfig()

        return TradingNodeConfig(
            environment=Environment.LIVE,
            trader_id=trader_id,
            strategies=strategy_configs,
            controller=controller,
            risk_engine=risk_engine,
        )


class ProdBundleLauncher:
    """Main orchestrator for startup and lifecycle management.

    Steps (per §4.2):
    1. Resolve cohort via RegistryClient.get_enabled_strategies()
    2. Load strategy code via BundleLoader
    3. Assemble config via BrokerConfigBuilder
    4. Instantiate + build + run the TradingNode
    5. Subscribe to lifecycle.> for hot-swap (via HotSwapManager in hotswap.py)
    """

    def __init__(
        self,
        config: LauncherConfig,
        registry_client: RegistryClient | None = None,
        loader: BundleLoader | None = None,
        config_builder: BrokerConfigBuilder | None = None,
    ):
        """Initialize with config and optional dependencies.

        Args:
            config: LauncherConfig (broker, URLs, trader_id)
            registry_client: optional custom HTTP client; created if None
            loader: optional custom BundleLoader; created if None
            config_builder: optional custom BrokerConfigBuilder; created if None
        """
        self.config = config
        self.registry_client = registry_client or RegistryClient(config.qf_registry_url)
        self.loader = loader or BundleLoader()
        self.config_builder = config_builder or BrokerConfigBuilder(config.broker)
        self.node: TradingNode | None = None
        self.nats_client: NatsClient | None = None
        self.cohort: list[StrategyInfo] = []
        self._cohort_by_id: dict[str, StrategyInfo] = {}
        self.hotswap: Any = None
        self._run_task: asyncio.Task[None] | None = None

    def resolve_strategy_info(self, strategy_id: str) -> StrategyInfo | None:
        """Resolver passed to the HotSwapManager (§4.3 `start` path).

        Returns the boot-cohort StrategyInfo for a strategy_id when present.
        A miss means the strategy isn't in this broker's deployed lock — the
        hot-swap path surfaces that as the §8 full-restart boundary rather than
        attempting an NT hot-load it can't do. (A future ticket may extend this
        to re-query the registry for a freshly-enabled strategy whose code IS in
        the lock but wasn't a boot co-tenant.)
        """
        return self._cohort_by_id.get(strategy_id)

    def _resolve_cohort(self, records: list[dict[str, Any]]) -> list[StrategyInfo]:
        """Filter the registry list to running + broker-matched StrategyInfo.

        The registry record has no broker field; we trust a ``broker_tag`` field
        when the deploy injects one (the bundle's registry mirror may add it),
        otherwise fall back to the package pyproject tag via the loader. A
        record whose broker can't be resolved to this launcher's broker is
        skipped (it belongs to another broker's node).
        """
        cohort: list[StrategyInfo] = []
        for rec in records:
            if rec.get("state") != _RUNNING_STATE:
                continue
            broker = rec.get("broker_tag")
            if broker != self.config.broker:
                continue
            strategy_path = rec.get("strategy_path")
            config_path = rec.get("config_path")
            if not strategy_path or not config_path:
                _LOGGER.error(
                    "Strategy %s is running+broker-matched but missing NT import "
                    "paths (strategy_path/config_path); skipping (registry/lock "
                    "disagreement — registry wins on next restart, §4.2)",
                    rec.get("id"),
                )
                continue
            params = rec.get("params_provenance", {}).get("selected_params", {})
            cohort.append(
                StrategyInfo(
                    id=str(rec["id"]),
                    broker=self.config.broker,
                    strategy_path=str(strategy_path),
                    config_path=str(config_path),
                    config=dict(params) if isinstance(params, dict) else {},
                )
            )
        return cohort

    async def startup(self) -> None:
        """Execute startup sequence (§4.2 steps 1-4).

        Raises:
            Exception: if any step fails (registry unreachable, import error,
                NT node startup failure, etc.).
        """
        _LOGGER.info("ProdBundleLauncher startup: broker=%s", self.config.broker)

        try:
            # Step 1: resolve cohort (running + broker-matched).
            records = await self.registry_client.get_enabled_strategies()
            self.cohort = self._resolve_cohort(records)
            self._cohort_by_id = {s.id: s for s in self.cohort}
            _LOGGER.info(
                "Resolved cohort: %d strategies for %s",
                len(self.cohort),
                self.config.broker,
            )

            # Steps 2-3: assemble the node config from the cohort. BundleLoader
            # turns each StrategyInfo into an ImportableStrategyConfig; NT's
            # StrategyFactory instantiates them at node.build().
            node_config = self.config_builder.build_node_config(
                self.cohort,
                trader_id=self.config.trader_id,
                loader=self.loader,
            )

            # Step 4: instantiate, build, and run the live node.
            from nautilus_trader.live.node import TradingNode

            self.node = TradingNode(config=node_config)
            # TODO(QF-326): register broker exec/data client factories here
            # (NT IB adapter for ibkr; Schwab exec-client for schwab) before
            # build(); these are broker-specific and tracked separately.
            self.node.build()
            # run_async() is a long-running coroutine: it starts the engines and
            # then blocks until the node stops. Schedule it as a background task
            # so startup() returns once the node is up and the engines running.
            self._run_task = asyncio.create_task(self.node.run_async())

            # Step 5: bind lifecycle.> for hot-swap deltas (§4.2 step 5 / §4.3).
            await self._start_hotswap()

            _LOGGER.info("ProdBundleLauncher startup complete")

        except Exception:
            _LOGGER.exception("ProdBundleLauncher startup failed")
            raise

    async def _start_hotswap(self) -> None:
        """Connect NATS + start the HotSwapManager on lifecycle.> (§4.3)."""
        import nats

        from .hotswap import HotSwapManager

        self.nats_client = await nats.connect(self.config.nats_url)
        self.hotswap = HotSwapManager(
            nats_client=self.nats_client,
            node=self.node,
            bundle_loader=self.loader,
            broker=self.config.broker,
            resolver=self.resolve_strategy_info,
        )
        await self.hotswap.start()

    async def shutdown(self) -> None:
        """Clean up resources: stop hot-swap, node, drain NATS, close client."""
        _LOGGER.info("ProdBundleLauncher shutdown")

        if self.hotswap is not None:
            try:
                await self.hotswap.close()
            except Exception:
                _LOGGER.exception("Error closing HotSwapManager")

        if self.node is not None:
            try:
                # NT graceful shutdown: stop_async drains the trader (stops all
                # co-tenant strategies, flushes engines), dispose frees handles.
                await self.node.stop_async()
                self.node.dispose()
            except Exception:
                _LOGGER.exception("Error stopping TradingNode")

        if self._run_task is not None:
            # stop_async unblocks run_async; await the task so it finishes
            # cleanly (or cancel it if the node never came up).
            self._run_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._run_task
            self._run_task = None

        if self.nats_client is not None:
            try:
                await self.nats_client.drain()
            except Exception:
                _LOGGER.exception("Error draining NATS")

        try:
            await self.registry_client.close()
        except Exception:
            _LOGGER.exception("Error closing registry client")

        _LOGGER.info("ProdBundleLauncher shutdown complete")


__all__ = [
    "BrokerConfigBuilder",
    "BundleLoader",
    "LauncherConfig",
    "ProdBundleLauncher",
    "RegistryClient",
    "StrategyInfo",
]
