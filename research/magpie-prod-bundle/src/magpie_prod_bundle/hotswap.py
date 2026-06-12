"""Hot-swap orchestrator — NATS lifecycle event subscriber (QF-327).

Listens on lifecycle.<strategy_id>.<action> for `start` and `halt` events
(per docs/tdd/nats-subjects.md §2.5 and strategy-deployment-topology.md §4.3).

On `start` → `running`: build the strategy from the bundle and add+start it on
    the running TradingNode (no process restart).
On `halt` → `halted`: stop the strategy (NT cancels its working orders; open
    positions are left, per §4.3).

Pause/resume and other registry transitions don't change the TradingNode;
they're gate-evaluator concerns (§4.3).

── NT runtime hot-swap capability (nautilus-trader 1.227.0) ──────────────────

Confirmed by reading the installed package (nautilus_trader/trading/trader.py):

- ``node.trader.start_strategy(StrategyId)`` and
  ``node.trader.stop_strategy(StrategyId)`` work on a RUNNING node — they only
  warn if the strategy is already in the target state (lines 554-636). No
  controller, no restart needed. `stop_strategy` calls `strategy.stop()`, which
  cancels the strategy's working orders and leaves positions — exactly the
  `halt` semantics §4.3 specifies.
- ``node.trader.add_strategy(strategy)`` on a RUNNING node is GATED: it no-ops
  with "Cannot add a strategy to a running trader" UNLESS the trader has a
  ``Controller`` (line 396: ``if self.is_running and not self._has_controller``).
  The launcher's ``BrokerConfigBuilder`` registers a stock ``Controller`` in the
  node config precisely to flip ``_has_controller`` True, which makes runtime
  ``add_strategy`` legal. We verified against a real built node that
  ``trader._has_controller`` is True with the controller in config.

So the FULL hot-swap (load a brand-new co-tenant mid-session) is supported via:
``node.trader.add_strategy(strategy)`` then ``node.trader.start_strategy(id)``.

NT limitation we did NOT fabricate around: NT does not expose the live
``Controller`` instance off the public node/kernel surface, and there is no
public API to *reconfigure* an already-built node's broker exec/data clients at
runtime. So a `start` for a strategy whose **code/package is not already in the
deployed lock** (never imported by this process) cannot be hot-loaded — that is
the §8 "needs full-bundle restart" boundary, and `_handle_start` surfaces it as
a hard error rather than silently dropping the event. The §6 fail-safe then
applies: the registry-reconciling launcher restart brings the live cohort back
in line with the registry. This matches the design's own §5.1/§8 statement that
hot-swap can only swap to code already importable in the running bundle.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

    from nats.aio.client import Client as NatsClient
    from nats.aio.msg import Msg

    from .launcher import StrategyInfo


_LOGGER = logging.getLogger(__name__)


class TransitionEvent:
    """Deserialized lifecycle.> event payload.

    Mirrors server/strategy/lifecycle.ts TransitionEvent:
        from: LifecycleState
        to: LifecycleState
        action: LifecycleAction ("start" | "halt" | others not published to bundles)
        ts: ISO 8601 timestamp
        actor: "operator" | "system" | model_id
        reason?: optional string
    """

    def __init__(
        self,
        from_state: str,
        to_state: str,
        action: str,
        ts: str,
        actor: str,
        reason: str | None = None,
    ):
        self.from_state = from_state
        self.to_state = to_state
        self.action = action
        self.ts = ts
        self.actor = actor
        self.reason = reason

    @classmethod
    def from_json(cls, data: str) -> TransitionEvent:
        """Parse JSON payload into TransitionEvent.

        Raises:
            ValueError: if JSON is malformed or missing required fields.
        """
        try:
            obj = json.loads(data)
        except json.JSONDecodeError as e:
            msg = f"Invalid JSON in lifecycle event: {e}"
            raise ValueError(msg) from e

        required = {"from", "to", "action", "ts", "actor"}
        if not required.issubset(obj.keys()):
            msg = f"Missing required fields: {required - obj.keys()}"
            raise ValueError(msg)

        return cls(
            from_state=obj["from"],
            to_state=obj["to"],
            action=obj["action"],
            ts=obj["ts"],
            actor=obj["actor"],
            reason=obj.get("reason"),
        )


class HotSwapManager:
    """Manages runtime strategy add/remove via NATS lifecycle events (§4.3).

    Drives the running node's ``Trader`` directly:
    - On `start` event: resolve the strategy's NT import paths, build a
      ``Strategy`` via the bundle loader, ``node.trader.add_strategy`` (legal
      because the node config registered a ``Controller``), then
      ``node.trader.start_strategy``.
    - On `halt` event: ``node.trader.stop_strategy`` (cancels working orders,
      leaves positions).

    See the module docstring for the confirmed NT 1.227.0 capability + the one
    documented limitation (a strategy whose code isn't already in the deployed
    lock can't be hot-loaded; that's the full-restart boundary, §8).
    """

    def __init__(
        self,
        nats_client: NatsClient,
        node: Any,
        bundle_loader: Any,
        broker: str,
        resolver: Callable[[str], StrategyInfo | None] | None = None,
    ):
        """Initialize the hot-swap manager.

        Args:
            nats_client: connected nats.aio.client.Client
            node: running NT TradingNode instance (has a ``.trader``)
            bundle_loader: BundleLoader instance for building strategies
            broker: "schwab" | "ibkr" — filter lifecycle events by broker tag
            resolver: callable mapping a kebab-case strategy_id to its
                ``StrategyInfo`` (NT import paths + config) for a `start` event.
                Returns None when the strategy isn't in this broker's deployed
                lock — `_handle_start` then surfaces the §8 restart boundary.
                The launcher supplies this from its boot cohort + registry.
        """
        self.nats_client = nats_client
        self.node = node
        self.bundle_loader = bundle_loader
        self.broker = broker
        self._resolver = resolver
        self._sub_task: asyncio.Task[None] | None = None
        self._closed = False

    async def start(self) -> None:
        """Subscribe to lifecycle.> and start the event loop.

        Spawns a background task to handle incoming events. Callers should
        store the returned task and await it on shutdown (or let it run
        for the lifetime of the launcher).
        """
        self._sub_task = asyncio.create_task(self._subscribe_loop())
        _LOGGER.info("HotSwapManager started")

    async def _subscribe_loop(self) -> None:
        """Main subscription loop — listen for lifecycle.> events.

        Processes events one at a time. Errors in event handling are logged
        but don't break the loop (fail-safe: registry wins on next full
        launcher restart).
        """
        subject = "lifecycle.>"
        _LOGGER.info("Subscribing to %s", subject)

        try:
            subscription = await self.nats_client.subscribe(subject)
        except Exception as e:
            _LOGGER.exception("Failed to subscribe to %s: %s", subject, e)
            return

        try:
            async for msg in subscription.messages:
                if self._closed:
                    break
                try:
                    await self._handle_event(msg)
                except Exception as e:
                    _LOGGER.exception("Error handling lifecycle event: %s", e)
        except Exception as e:
            _LOGGER.exception("Subscription loop error: %s", e)
        finally:
            try:
                await subscription.unsubscribe()
            except Exception as e:
                _LOGGER.debug("Error unsubscribing: %s", e)

    async def _handle_event(self, msg: Msg) -> None:
        """Process a single lifecycle event.

        Parses the subject to extract strategy_id and action, then
        dispatches to _handle_start or _handle_halt.

        Args:
            msg: nats.aio.msg.Msg from the subscription.
        """
        subject_parts = msg.subject.split(".")
        if len(subject_parts) < 3:
            _LOGGER.warning("Malformed lifecycle subject: %s", msg.subject)
            return

        # Subject format: lifecycle.<strategy_id>.<action>
        # <strategy_id> can contain hyphens, so we reassemble from the end.
        action = subject_parts[-1]
        strategy_id = ".".join(subject_parts[1:-1])

        try:
            event = TransitionEvent.from_json(msg.data.decode("utf-8"))
        except ValueError as e:
            _LOGGER.warning("Failed to parse event payload: %s", e)
            return

        _LOGGER.info(
            "Lifecycle event: strategy=%s action=%s from=%s to=%s",
            strategy_id,
            action,
            event.from_state,
            event.to_state,
        )

        # Only start and halt change the TradingNode (§4.3).
        if action == "start" and event.to_state == "running":
            await self._handle_start(strategy_id, event)
        elif action == "halt" and event.to_state == "halted":
            await self._handle_halt(strategy_id, event)
        else:
            _LOGGER.debug(
                "Ignoring non-actionable transition: %s %s → %s",
                strategy_id,
                action,
                event.to_state,
            )

    async def _handle_start(self, strategy_id: str, event: TransitionEvent) -> None:
        """Handle a strategy start event (→ running).

        Wires NT's runtime add+start on the running node:
        1. If the strategy is already registered (a boot co-tenant or previously
           added), just ``start_strategy`` it.
        2. Otherwise resolve its NT import paths via the resolver, build it via
           the bundle loader, ``add_strategy`` (legal — the node has a
           Controller), then ``start_strategy``.

        A strategy the resolver can't place (not in this broker's deployed lock)
        is the §8 full-restart boundary: we log an error and stop, rather than
        fabricate a hot-load NT can't do. The §6 fail-safe (registry-reconciling
        restart) closes the gap.

        Args:
            strategy_id: kebab-case identifier (e.g. "cl-scalp")
            event: the parsed TransitionEvent
        """
        trader = self.node.trader

        # Already registered (boot co-tenant or earlier add) → just start it.
        for sid in trader.strategy_ids():
            if str(sid).lower().rsplit("-", 1)[0] == strategy_id.lower():
                trader.start_strategy(sid)
                _LOGGER.info(
                    "Started already-registered strategy %s (%s)", strategy_id, sid
                )
                return

        # Not registered → resolve, build, add, start.
        info: StrategyInfo | None = (
            self._resolver(strategy_id) if self._resolver is not None else None
        )
        if info is None:
            _LOGGER.error(
                "start for %s: not in %s deployed lock (no resolver match). "
                "NT cannot hot-load code this process never imported — this is "
                "the §8 full-bundle-restart boundary; the §6 registry-reconciling "
                "restart will bring the live cohort back in line. Ignoring event.",
                strategy_id,
                self.broker,
            )
            return

        strategy = self.bundle_loader.build_strategy(info)
        trader.add_strategy(strategy)  # legal at runtime: node has a Controller
        trader.start_strategy(strategy.id)
        _LOGGER.info("Hot-added + started strategy %s (%s)", strategy_id, strategy.id)

    async def _handle_halt(self, strategy_id: str, event: TransitionEvent) -> None:
        """Handle a strategy halt event (→ halted).

        Calls ``node.trader.stop_strategy(StrategyId)``. NT's ``stop_strategy``
        invokes ``strategy.stop()``, which cancels the strategy's working orders
        and leaves open positions — exactly the §4.3 `halt` semantics. A no-op
        (warns) if this node doesn't host the strategy or it's already stopped.

        Args:
            strategy_id: kebab-case identifier (e.g. "cl-scalp")
            event: the parsed TransitionEvent
        """
        trader = self.node.trader
        for sid in trader.strategy_ids():
            if str(sid).lower().rsplit("-", 1)[0] == strategy_id.lower():
                trader.stop_strategy(sid)
                _LOGGER.info("Halted strategy %s (%s)", strategy_id, sid)
                return
        _LOGGER.info(
            "halt for %s: not hosted on this %s node; no-op (§4.3)",
            strategy_id,
            self.broker,
        )

    async def close(self) -> None:
        """Gracefully close the subscription and wait for the loop to exit."""
        _LOGGER.info("HotSwapManager closing")
        self._closed = True

        if self._sub_task is not None:
            try:
                await asyncio.wait_for(self._sub_task, timeout=5.0)
            except TimeoutError:
                _LOGGER.warning("HotSwapManager close timed out; cancelling task")
                self._sub_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._sub_task
            except Exception as e:
                _LOGGER.debug("Error waiting for _sub_task: %s", e)
            finally:
                self._sub_task = None

        _LOGGER.info("HotSwapManager closed")


__all__ = [
    "HotSwapManager",
    "TransitionEvent",
]
