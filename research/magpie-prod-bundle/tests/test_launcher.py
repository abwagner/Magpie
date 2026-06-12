"""Tests for magpie_prod_bundle.launcher (QF-326).

Unit tests for the config builder, registry client, bundle loader, and the
startup/shutdown sequence. NT, NATS, and HTTP are mocked; the mocks match the
real NT 1.227.0 signatures the module is wired against (TradingNodeConfig with a
Controller, ImportableStrategyConfig, StrategyFactory, node.build/run_async/
stop_async/dispose).
"""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from magpie_prod_bundle.launcher import (
    BrokerConfigBuilder,
    BundleLoader,
    LauncherConfig,
    ProdBundleLauncher,
    RegistryClient,
    StrategyInfo,
)

# ── LauncherConfig ────────────────────────────────────────────────


class TestLauncherConfigFromEnv:
    """Tests for LauncherConfig.from_env()."""

    def test_from_env_uses_defaults(self) -> None:
        """Default URLs + derived trader_id are used when env is unset."""
        with patch.dict(os.environ, {}, clear=True):
            config = LauncherConfig.from_env("schwab")
            assert config.broker == "schwab"
            assert config.qf_registry_url == "http://localhost:3000"
            assert config.nats_url == "nats://localhost:4222"
            assert config.trader_id == "PROD-SCHWAB-001"

    def test_from_env_reads_custom_urls(self) -> None:
        """Custom URLs + trader_id override defaults."""
        env = {
            "QF_REGISTRY_URL": "http://qf.example.com:8080",
            "NATS_URL": "nats://nats.example.com:4222",
            "QF_TRADER_ID": "PROD-IBKR-007",
        }
        with patch.dict(os.environ, env, clear=True):
            config = LauncherConfig.from_env("ibkr")
            assert config.broker == "ibkr"
            assert config.qf_registry_url == "http://qf.example.com:8080"
            assert config.nats_url == "nats://nats.example.com:4222"
            assert config.trader_id == "PROD-IBKR-007"

    def test_from_env_empty_url_raises(self) -> None:
        """Empty QF_REGISTRY_URL is treated as missing."""
        with (
            patch.dict(os.environ, {"QF_REGISTRY_URL": ""}, clear=True),
            pytest.raises(ValueError, match="QF_REGISTRY_URL not set"),
        ):
            LauncherConfig.from_env("schwab")

    def test_from_env_empty_nats_url_raises(self) -> None:
        """Empty NATS_URL is treated as missing."""
        env = {"QF_REGISTRY_URL": "http://qf.example.com", "NATS_URL": ""}
        with (
            patch.dict(os.environ, env, clear=True),
            pytest.raises(ValueError, match="NATS_URL not set"),
        ):
            LauncherConfig.from_env("schwab")


# ── StrategyInfo ──────────────────────────────────────────────────


class TestStrategyInfo:
    """Tests for StrategyInfo dataclass."""

    def test_strategy_info_construction(self) -> None:
        """StrategyInfo carries NT import paths + config."""
        info = StrategyInfo(
            id="cl-scalp",
            broker="schwab",
            strategy_path="magpie_cl_scalp.strategies.cl_scalp:ClScalp",
            config_path="magpie_cl_scalp.strategies.cl_scalp:ClScalpConfig",
            config={"fast": 10},
        )
        assert info.id == "cl-scalp"
        assert info.broker == "schwab"
        assert info.strategy_path.endswith(":ClScalp")
        assert info.config_path.endswith(":ClScalpConfig")
        assert info.config == {"fast": 10}


# ── RegistryClient ────────────────────────────────────────────────


def _make_http_resp(payload: Any) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = MagicMock(return_value=payload)
    return resp


class TestRegistryClient:
    """Tests for RegistryClient against the confirmed /api/strategies API."""

    def test_registry_client_init_strips_trailing_slash(self) -> None:
        client = RegistryClient("http://qf.example.com/")
        assert client.base_url == "http://qf.example.com"

    @pytest.mark.asyncio
    async def test_get_enabled_strategies_hits_api_strategies(self) -> None:
        """GET /api/strategies and returns the bare array body."""
        records = [
            {"id": "cl-scalp", "state": "running"},
            {"id": "soxx-rotation", "state": "enabled"},
        ]
        http = AsyncMock()
        http.get.return_value = _make_http_resp(records)

        client = RegistryClient("http://localhost:3000", http_client=http)
        out = await client.get_enabled_strategies()

        assert out == records
        http.get.assert_awaited_once_with("http://localhost:3000/api/strategies")

    @pytest.mark.asyncio
    async def test_get_enabled_strategies_rejects_non_array(self) -> None:
        """A non-array body (e.g. an error object) raises."""
        http = AsyncMock()
        http.get.return_value = _make_http_resp({"error": "boom"})

        client = RegistryClient("http://localhost:3000", http_client=http)
        with pytest.raises(ValueError, match="non-array body"):
            await client.get_enabled_strategies()

    @pytest.mark.asyncio
    async def test_registry_client_close_does_not_close_injected_client(self) -> None:
        """close() leaves a caller-owned http client alone."""
        http = AsyncMock()
        client = RegistryClient("http://localhost:3000", http_client=http)
        await client.close()
        http.aclose.assert_not_called()


# ── BundleLoader ──────────────────────────────────────────────────


_INFO = StrategyInfo(
    id="cl-scalp",
    broker="schwab",
    strategy_path="pkg.mod:Strat",
    config_path="pkg.mod:StratConfig",
    config={"k": "v"},
)


class TestBundleLoaderImportableConfig:
    """Tests for BundleLoader.importable_strategy_config()."""

    def test_importable_strategy_config_shape(self) -> None:
        """Produces an ImportableStrategyConfig with the StrategyInfo paths."""
        loader = BundleLoader()
        cfg = loader.importable_strategy_config(_INFO)
        assert cfg.strategy_path == "pkg.mod:Strat"
        assert cfg.config_path == "pkg.mod:StratConfig"
        assert cfg.config == {"k": "v"}


class TestBundleLoaderBuildStrategy:
    """Tests for BundleLoader.build_strategy()."""

    def test_build_strategy_uses_nt_factory(self) -> None:
        """build_strategy delegates to NT's StrategyFactory.create."""
        loader = BundleLoader()
        sentinel = object()
        with patch(
            "nautilus_trader.trading.config.StrategyFactory.create",
            return_value=sentinel,
        ) as create:
            out = loader.build_strategy(_INFO)
        assert out is sentinel
        create.assert_called_once()
        importable = create.call_args.args[0]
        assert importable.strategy_path == "pkg.mod:Strat"


class TestBundleLoaderResolveBroker:
    """Tests for BundleLoader.resolve_broker()."""

    def test_resolve_broker_reads_metadata_field(self) -> None:
        md = MagicMock()
        md.get.return_value = "schwab"
        with patch("importlib.metadata.metadata", return_value=md):
            loader = BundleLoader()
            broker = loader.resolve_broker("cl-scalp", "magpie-cl-scalp")
        assert broker == "schwab"
        md.get.assert_called_once_with("QF-Broker")

    def test_resolve_broker_missing_package_returns_none(self) -> None:
        from importlib.metadata import PackageNotFoundError

        with patch(
            "importlib.metadata.metadata", side_effect=PackageNotFoundError("x")
        ):
            loader = BundleLoader()
            assert loader.resolve_broker("cl-scalp", "missing-pkg") is None


# ── BrokerConfigBuilder ────────────────────────────────────────────


class TestBrokerConfigBuilder:
    """Tests for BrokerConfigBuilder.build_node_config() against real NT."""

    def test_broker_config_builder_init(self) -> None:
        builder = BrokerConfigBuilder("schwab")
        assert builder.broker == "schwab"

    def test_build_node_config_real_nt_with_controller(self) -> None:
        """Builds a real TradingNodeConfig with a Controller + strategies.

        The Controller is what unlocks runtime add_strategy (QF-327); we assert
        it's present so the hot-swap contract is wired, and that the cohort's
        strategies land as importable configs.
        """
        builder = BrokerConfigBuilder("schwab")
        cohort = [_INFO]
        config = builder.build_node_config(cohort, trader_id="PROD-SCHWAB-001")

        assert str(config.trader_id) == "PROD-SCHWAB-001"
        # Controller present → trader._has_controller will be True at build.
        assert config.controller is not None
        assert (
            config.controller.controller_path
            == "nautilus_trader.trading.controller:Controller"
        )
        assert len(config.strategies) == 1
        assert config.strategies[0].strategy_path == "pkg.mod:Strat"
        assert config.risk_engine is not None

    def test_build_node_config_empty_cohort(self) -> None:
        builder = BrokerConfigBuilder("ibkr")
        config = builder.build_node_config([], trader_id="PROD-IBKR-001")
        assert config.strategies == []
        assert config.controller is not None

    def test_built_node_has_controller_flag(self) -> None:
        """End-to-end: a node built from the config has _has_controller True.

        This is the load-bearing NT behavior for QF-327 — without it, runtime
        add_strategy no-ops (trader.py:396).
        """
        import asyncio

        from nautilus_trader.live.node import TradingNode

        # node.build() reaches NT internals that call asyncio.get_event_loop();
        # the bare CI test process has no loop, so provide one explicitly.
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        builder = BrokerConfigBuilder("schwab")
        config = builder.build_node_config([], trader_id="PROD-CTRL-TEST")
        node = TradingNode(config=config)
        try:
            node.build()
            assert node.trader._has_controller is True
        finally:
            node.dispose()
            loop.close()
            asyncio.set_event_loop(None)


# ── ProdBundleLauncher ────────────────────────────────────────────


def _cfg(broker: str = "schwab") -> LauncherConfig:
    return LauncherConfig(
        broker=broker,
        qf_registry_url="http://localhost:3000",
        nats_url="nats://localhost:4222",
        trader_id=f"PROD-{broker.upper()}-001",
    )


class TestProdBundleLauncherInit:
    """Tests for ProdBundleLauncher initialization."""

    def test_launcher_init_with_defaults(self) -> None:
        launcher = ProdBundleLauncher(_cfg())
        assert isinstance(launcher.registry_client, RegistryClient)
        assert isinstance(launcher.loader, BundleLoader)
        assert isinstance(launcher.config_builder, BrokerConfigBuilder)
        assert launcher.node is None
        assert launcher.nats_client is None
        assert launcher.cohort == []

    def test_launcher_init_with_custom_clients(self) -> None:
        mock_registry = MagicMock(spec=RegistryClient)
        mock_loader = MagicMock(spec=BundleLoader)
        mock_builder = MagicMock(spec=BrokerConfigBuilder)
        launcher = ProdBundleLauncher(
            _cfg("ibkr"),
            registry_client=mock_registry,
            loader=mock_loader,
            config_builder=mock_builder,
        )
        assert launcher.registry_client is mock_registry
        assert launcher.loader is mock_loader
        assert launcher.config_builder is mock_builder


class TestProdBundleLauncherResolveCohort:
    """Tests for the registry → cohort filter (running + broker-matched)."""

    def test_filters_to_running_and_broker_matched(self) -> None:
        launcher = ProdBundleLauncher(_cfg("schwab"))
        records: list[dict[str, Any]] = [
            # running + schwab + has NT paths → kept
            {
                "id": "cl-scalp",
                "state": "running",
                "broker_tag": "schwab",
                "strategy_path": "pkg:Strat",
                "config_path": "pkg:StratConfig",
                "params_provenance": {"selected_params": {"fast": 3}},
            },
            # running but wrong broker → dropped
            {
                "id": "soxx-rotation",
                "state": "running",
                "broker_tag": "ibkr",
                "strategy_path": "pkg:Strat",
                "config_path": "pkg:StratConfig",
            },
            # schwab but not running → dropped
            {
                "id": "vix-carry",
                "state": "enabled",
                "broker_tag": "schwab",
                "strategy_path": "pkg:Strat",
                "config_path": "pkg:StratConfig",
            },
        ]
        cohort = launcher._resolve_cohort(records)
        assert [s.id for s in cohort] == ["cl-scalp"]
        assert cohort[0].config == {"fast": 3}

    def test_running_broker_matched_missing_paths_is_skipped(self) -> None:
        """A running+matched record without NT import paths is skipped, logged."""
        launcher = ProdBundleLauncher(_cfg("schwab"))
        records = [
            {"id": "cl-scalp", "state": "running", "broker_tag": "schwab"},
        ]
        cohort = launcher._resolve_cohort(records)
        assert cohort == []


class TestProdBundleLauncherStartup:
    """Tests for ProdBundleLauncher.startup() with NT + NATS mocked."""

    @pytest.mark.asyncio
    async def test_startup_with_empty_cohort_builds_and_runs_node(self) -> None:
        """startup builds the node config, builds/runs the node, binds hotswap."""
        launcher = ProdBundleLauncher(_cfg("schwab"))

        mock_registry = AsyncMock(spec=RegistryClient)
        mock_registry.get_enabled_strategies.return_value = []
        launcher.registry_client = mock_registry

        mock_node = MagicMock()
        mock_node.run_async = AsyncMock()

        with (
            patch(
                "nautilus_trader.live.node.TradingNode", return_value=mock_node
            ) as node_cls,
            patch.object(launcher, "_start_hotswap", new_callable=AsyncMock) as hs,
        ):
            await launcher.startup()

        node_cls.assert_called_once()
        mock_node.build.assert_called_once()
        hs.assert_awaited_once()
        assert launcher.node is mock_node
        # run_async scheduled as a background task, not awaited inline.
        assert launcher._run_task is not None
        launcher._run_task.cancel()

    @pytest.mark.asyncio
    async def test_startup_filters_by_broker_and_state(self) -> None:
        """startup keeps only running + broker-matched strategies in the cohort."""
        launcher = ProdBundleLauncher(_cfg("schwab"))

        mock_registry = AsyncMock(spec=RegistryClient)
        mock_registry.get_enabled_strategies.return_value = [
            {
                "id": "cl-scalp",
                "state": "running",
                "broker_tag": "schwab",
                "strategy_path": "pkg:Strat",
                "config_path": "pkg:StratConfig",
            },
            {"id": "soxx-rotation", "state": "running", "broker_tag": "ibkr"},
        ]
        launcher.registry_client = mock_registry

        mock_builder = MagicMock(spec=BrokerConfigBuilder)
        launcher.config_builder = mock_builder

        mock_node = MagicMock()
        mock_node.run_async = AsyncMock()

        with (
            patch("nautilus_trader.live.node.TradingNode", return_value=mock_node),
            patch.object(launcher, "_start_hotswap", new_callable=AsyncMock),
        ):
            await launcher.startup()

        assert [s.id for s in launcher.cohort] == ["cl-scalp"]
        assert launcher._cohort_by_id["cl-scalp"].broker == "schwab"
        # builder called with the filtered cohort.
        passed_cohort = mock_builder.build_node_config.call_args.args[0]
        assert [s.id for s in passed_cohort] == ["cl-scalp"]
        if launcher._run_task:
            launcher._run_task.cancel()

    @pytest.mark.asyncio
    async def test_startup_registry_error_propagates(self) -> None:
        launcher = ProdBundleLauncher(_cfg("schwab"))
        mock_registry = AsyncMock(spec=RegistryClient)
        mock_registry.get_enabled_strategies.side_effect = Exception(
            "registry unreachable"
        )
        launcher.registry_client = mock_registry
        with pytest.raises(Exception, match="registry unreachable"):
            await launcher.startup()


class TestProdBundleLauncherResolveStrategyInfo:
    """Tests for the hot-swap resolver."""

    def test_resolver_hits_boot_cohort(self) -> None:
        launcher = ProdBundleLauncher(_cfg("schwab"))
        launcher._cohort_by_id = {"cl-scalp": _INFO}
        assert launcher.resolve_strategy_info("cl-scalp") is _INFO

    def test_resolver_miss_returns_none(self) -> None:
        launcher = ProdBundleLauncher(_cfg("schwab"))
        assert launcher.resolve_strategy_info("unknown") is None


class TestProdBundleLauncherShutdown:
    """Tests for ProdBundleLauncher.shutdown()."""

    @pytest.mark.asyncio
    async def test_shutdown_with_no_resources(self) -> None:
        launcher = ProdBundleLauncher(_cfg())
        launcher.registry_client = AsyncMock(spec=RegistryClient)
        await launcher.shutdown()  # should not raise

    @pytest.mark.asyncio
    async def test_shutdown_stops_node_and_hotswap(self) -> None:
        launcher = ProdBundleLauncher(_cfg())
        launcher.registry_client = AsyncMock(spec=RegistryClient)

        mock_node = MagicMock()
        mock_node.stop_async = AsyncMock()
        launcher.node = mock_node

        mock_hotswap = AsyncMock()
        launcher.hotswap = mock_hotswap

        await launcher.shutdown()

        mock_hotswap.close.assert_awaited_once()
        mock_node.stop_async.assert_awaited_once()
        mock_node.dispose.assert_called_once()

    @pytest.mark.asyncio
    async def test_shutdown_closes_registry_client(self) -> None:
        mock_registry = AsyncMock(spec=RegistryClient)
        launcher = ProdBundleLauncher(_cfg(), registry_client=mock_registry)
        await launcher.shutdown()
        mock_registry.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_shutdown_drains_nats_client(self) -> None:
        launcher = ProdBundleLauncher(_cfg())
        launcher.registry_client = AsyncMock(spec=RegistryClient)
        mock_nats = AsyncMock()
        launcher.nats_client = mock_nats
        await launcher.shutdown()
        mock_nats.drain.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_shutdown_handles_errors_gracefully(self) -> None:
        mock_registry = AsyncMock(spec=RegistryClient)
        mock_registry.close.side_effect = Exception("close failed")
        launcher = ProdBundleLauncher(_cfg(), registry_client=mock_registry)
        await launcher.shutdown()  # should not raise
