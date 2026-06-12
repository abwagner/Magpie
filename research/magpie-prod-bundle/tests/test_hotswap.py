"""Tests for magpie_prod_bundle.hotswap (QF-327).

Unit tests for the hot-swap manager, lifecycle event parsing, and subscription
management. Tests use mocked NATS clients and TradingNode instances.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from magpie_prod_bundle.hotswap import HotSwapManager, TransitionEvent
from magpie_prod_bundle.launcher import StrategyInfo

# ── TransitionEvent ───────────────────────────────────────────────


class TestTransitionEventFromJson:
    """Tests for TransitionEvent.from_json()."""

    def test_from_json_complete_payload(self) -> None:
        """from_json parses complete lifecycle event payload."""
        payload = json.dumps(
            {
                "from": "enabled",
                "to": "running",
                "action": "start",
                "ts": "2025-06-07T12:00:00Z",
                "actor": "operator",
                "reason": "manual trigger",
            }
        )
        event = TransitionEvent.from_json(payload)

        assert event.from_state == "enabled"
        assert event.to_state == "running"
        assert event.action == "start"
        assert event.ts == "2025-06-07T12:00:00Z"
        assert event.actor == "operator"
        assert event.reason == "manual trigger"

    def test_from_json_without_reason(self) -> None:
        """from_json handles missing reason field."""
        payload = json.dumps(
            {
                "from": "running",
                "to": "halted",
                "action": "halt",
                "ts": "2025-06-07T12:00:01Z",
                "actor": "system",
            }
        )
        event = TransitionEvent.from_json(payload)

        assert event.from_state == "running"
        assert event.to_state == "halted"
        assert event.action == "halt"
        assert event.ts == "2025-06-07T12:00:01Z"
        assert event.actor == "system"
        assert event.reason is None

    def test_from_json_invalid_json(self) -> None:
        """from_json raises ValueError on malformed JSON."""
        with pytest.raises(ValueError, match="Invalid JSON"):
            TransitionEvent.from_json("not valid json")

    def test_from_json_missing_field(self) -> None:
        """from_json raises ValueError if required field is missing."""
        payload = json.dumps(
            {
                "from": "enabled",
                "to": "running",
                # missing action
                "ts": "2025-06-07T12:00:00Z",
                "actor": "operator",
            }
        )
        with pytest.raises(ValueError, match="Missing required fields"):
            TransitionEvent.from_json(payload)

    def test_from_json_missing_multiple_fields(self) -> None:
        """from_json reports all missing fields."""
        payload = json.dumps(
            {
                "from": "enabled",
                # missing: to, action, ts, actor
            }
        )
        with pytest.raises(ValueError, match="Missing required fields"):
            TransitionEvent.from_json(payload)


# ── HotSwapManager ────────────────────────────────────────────────


class TestHotSwapManagerInit:
    """Tests for HotSwapManager initialization."""

    def test_hotswap_manager_init(self) -> None:
        """HotSwapManager stores dependencies including the resolver."""
        mock_nats = MagicMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()
        resolver = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
            resolver=resolver,
        )

        assert manager.nats_client is mock_nats
        assert manager.node is mock_node
        assert manager.bundle_loader is mock_loader
        assert manager.broker == "schwab"
        assert manager._resolver is resolver
        assert manager._sub_task is None
        assert manager._closed is False


class TestHotSwapManagerStart:
    """Tests for HotSwapManager.start()."""

    @pytest.mark.asyncio
    async def test_hotswap_manager_start(self) -> None:
        """start() spawns a background subscription task."""
        mock_nats = AsyncMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
        )

        # Patch the _subscribe_loop to not actually run
        with patch.object(manager, "_subscribe_loop", new_callable=AsyncMock):
            await manager.start()
            assert manager._sub_task is not None


class TestHotSwapManagerHandleEvent:
    """Tests for HotSwapManager._handle_event()."""

    @pytest.mark.asyncio
    async def test_handle_event_malformed_subject(self) -> None:
        """_handle_event logs warning on malformed subject."""
        mock_nats = MagicMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
        )

        msg = MagicMock()
        msg.subject = "malformed"
        msg.data = b"{}"

        # Should not raise
        with patch("magpie_prod_bundle.hotswap._LOGGER") as mock_logger:
            await manager._handle_event(msg)
            mock_logger.warning.assert_called()

    @pytest.mark.asyncio
    async def test_handle_event_invalid_json(self) -> None:
        """_handle_event logs warning on invalid JSON payload."""
        mock_nats = MagicMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
        )

        msg = MagicMock()
        msg.subject = "lifecycle.cl-scalp.start"
        msg.data = b"not valid json"

        # Should not raise
        with patch("magpie_prod_bundle.hotswap._LOGGER") as mock_logger:
            await manager._handle_event(msg)
            mock_logger.warning.assert_called()

    @pytest.mark.asyncio
    async def test_handle_event_start_action(self) -> None:
        """_handle_event dispatches start events to _handle_start."""
        mock_nats = MagicMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
        )

        msg = MagicMock()
        msg.subject = "lifecycle.cl-scalp.start"
        msg.data = json.dumps(
            {
                "from": "enabled",
                "to": "running",
                "action": "start",
                "ts": "2025-06-07T12:00:00Z",
                "actor": "operator",
            }
        ).encode("utf-8")

        with patch.object(
            manager, "_handle_start", new_callable=AsyncMock
        ) as mock_handle:
            await manager._handle_event(msg)
            mock_handle.assert_called_once()
            args, kwargs = mock_handle.call_args
            assert args[0] == "cl-scalp"
            assert isinstance(args[1], TransitionEvent)

    @pytest.mark.asyncio
    async def test_handle_event_halt_action(self) -> None:
        """_handle_event dispatches halt events to _handle_halt."""
        mock_nats = MagicMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
        )

        msg = MagicMock()
        msg.subject = "lifecycle.cl-scalp.halt"
        msg.data = json.dumps(
            {
                "from": "running",
                "to": "halted",
                "action": "halt",
                "ts": "2025-06-07T12:00:01Z",
                "actor": "system",
            }
        ).encode("utf-8")

        with patch.object(
            manager, "_handle_halt", new_callable=AsyncMock
        ) as mock_handle:
            await manager._handle_event(msg)
            mock_handle.assert_called_once()
            args, kwargs = mock_handle.call_args
            assert args[0] == "cl-scalp"
            assert isinstance(args[1], TransitionEvent)

    @pytest.mark.asyncio
    async def test_handle_event_ignores_pause_resume(self) -> None:
        """_handle_event ignores pause/resume (not co-tenant changes)."""
        mock_nats = MagicMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
        )

        msg = MagicMock()
        msg.subject = "lifecycle.cl-scalp.pause"
        msg.data = json.dumps(
            {
                "from": "running",
                "to": "paused",
                "action": "pause",
                "ts": "2025-06-07T12:00:02Z",
                "actor": "operator",
            }
        ).encode("utf-8")

        with patch("magpie_prod_bundle.hotswap._LOGGER") as mock_logger:
            await manager._handle_event(msg)
            # Should log debug about ignoring non-actionable transition
            assert any(
                "ignoring" in str(call).lower() or "Ignoring" in str(call)
                for call in mock_logger.mock_calls
            )

    @pytest.mark.asyncio
    async def test_handle_event_complex_strategy_id(self) -> None:
        """_handle_event handles strategy IDs with multiple hyphens."""
        mock_nats = MagicMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
        )

        msg = MagicMock()
        msg.subject = "lifecycle.soxx-rotation-v2.start"
        msg.data = json.dumps(
            {
                "from": "enabled",
                "to": "running",
                "action": "start",
                "ts": "2025-06-07T12:00:00Z",
                "actor": "operator",
            }
        ).encode("utf-8")

        with patch.object(
            manager, "_handle_start", new_callable=AsyncMock
        ) as mock_handle:
            await manager._handle_event(msg)
            args, kwargs = mock_handle.call_args
            assert args[0] == "soxx-rotation-v2"


def _start_event() -> TransitionEvent:
    return TransitionEvent(
        from_state="enabled",
        to_state="running",
        action="start",
        ts="2025-06-07T12:00:00Z",
        actor="operator",
    )


def _halt_event() -> TransitionEvent:
    return TransitionEvent(
        from_state="running",
        to_state="halted",
        action="halt",
        ts="2025-06-07T12:00:01Z",
        actor="system",
    )


def _manager(
    *,
    node: MagicMock,
    loader: MagicMock | None = None,
    resolver: Callable[[str], StrategyInfo | None] | None = None,
) -> HotSwapManager:
    return HotSwapManager(
        nats_client=MagicMock(),
        node=node,
        bundle_loader=loader or MagicMock(),
        broker="schwab",
        resolver=resolver,
    )


class TestHotSwapManagerHandleStart:
    """Tests for HotSwapManager._handle_start() against the real trader API."""

    @pytest.mark.asyncio
    async def test_start_already_registered_calls_start_strategy(self) -> None:
        """A boot co-tenant (already registered) is just started, not re-added."""
        node = MagicMock()
        # NT suffixes order_id_tag → "CL-SCALP-000"; matcher strips the suffix.
        node.trader.strategy_ids.return_value = ["CL-SCALP-000"]

        manager = _manager(node=node)
        await manager._handle_start("cl-scalp", _start_event())

        node.trader.start_strategy.assert_called_once_with("CL-SCALP-000")
        node.trader.add_strategy.assert_not_called()

    @pytest.mark.asyncio
    async def test_start_new_strategy_resolves_builds_adds_starts(self) -> None:
        """A not-yet-registered strategy is resolved, built, added, started."""
        node = MagicMock()
        node.trader.strategy_ids.return_value = []  # not registered yet

        built = MagicMock()
        built.id = "CL-SCALP-000"
        loader = MagicMock()
        loader.build_strategy.return_value = built

        info = object()
        resolver = MagicMock(return_value=info)

        manager = _manager(node=node, loader=loader, resolver=resolver)
        await manager._handle_start("cl-scalp", _start_event())

        resolver.assert_called_once_with("cl-scalp")
        loader.build_strategy.assert_called_once_with(info)
        node.trader.add_strategy.assert_called_once_with(built)
        node.trader.start_strategy.assert_called_once_with("CL-SCALP-000")

    @pytest.mark.asyncio
    async def test_start_unresolvable_is_restart_boundary(self) -> None:
        """A strategy not in the lock (resolver miss) logs the §8 boundary,
        and does NOT attempt add/start (NT can't hot-load unknown code)."""
        node = MagicMock()
        node.trader.strategy_ids.return_value = []
        resolver = MagicMock(return_value=None)

        manager = _manager(node=node, resolver=resolver)
        with patch("magpie_prod_bundle.hotswap._LOGGER") as mock_logger:
            await manager._handle_start("cl-scalp", _start_event())

        node.trader.add_strategy.assert_not_called()
        node.trader.start_strategy.assert_not_called()
        # Logged as an error referencing the restart boundary.
        assert mock_logger.error.called
        assert "restart" in str(mock_logger.error.call_args).lower()


class TestHotSwapManagerHandleHalt:
    """Tests for HotSwapManager._handle_halt() against the real trader API."""

    @pytest.mark.asyncio
    async def test_halt_hosted_calls_stop_strategy(self) -> None:
        """A hosted strategy is stopped (NT cancels working orders)."""
        node = MagicMock()
        node.trader.strategy_ids.return_value = ["CL-SCALP-000"]

        manager = _manager(node=node)
        await manager._handle_halt("cl-scalp", _halt_event())

        node.trader.stop_strategy.assert_called_once_with("CL-SCALP-000")

    @pytest.mark.asyncio
    async def test_halt_not_hosted_is_noop(self) -> None:
        """A strategy this node doesn't host is a no-op (§4.3)."""
        node = MagicMock()
        node.trader.strategy_ids.return_value = ["OTHER-000"]

        manager = _manager(node=node)
        await manager._handle_halt("cl-scalp", _halt_event())

        node.trader.stop_strategy.assert_not_called()


class TestHotSwapManagerClose:
    """Tests for HotSwapManager.close()."""

    @pytest.mark.asyncio
    async def test_close_with_no_task(self) -> None:
        """close() succeeds even if no task is running."""
        mock_nats = MagicMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
        )

        # Should not raise
        await manager.close()
        assert manager._closed is True

    @pytest.mark.asyncio
    async def test_close_cancels_task(self) -> None:
        """close() cancels and waits for the subscription task."""
        mock_nats = AsyncMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
        )

        # Create a dummy task
        import asyncio

        async def dummy_task() -> None:
            await asyncio.sleep(100)

        manager._sub_task = asyncio.create_task(dummy_task())

        await manager.close()
        assert manager._closed is True
        assert manager._sub_task is None or manager._sub_task.done()

    @pytest.mark.asyncio
    async def test_close_timeout_cancels_task(self) -> None:
        """close() cancels task if it doesn't finish within timeout."""
        mock_nats = MagicMock()
        mock_node = MagicMock()
        mock_loader = MagicMock()

        manager = HotSwapManager(
            nats_client=mock_nats,
            node=mock_node,
            bundle_loader=mock_loader,
            broker="schwab",
        )

        import asyncio

        # Create a task that never completes
        async def infinite_task() -> None:
            await asyncio.sleep(100)

        manager._sub_task = asyncio.create_task(infinite_task())

        await manager.close()
        assert manager._closed is True
