"""In-memory envelope registry for the parent-budget evaluation model.

Implements docs/tdd/risk-gate-architecture.md §2.1 (parent-budget) +
§3.5 (revocation). The gate evaluates parent intents at full impact;
once approved, the parent's ``envelope_id`` lives in this registry.
Subsequent child orders that NT submits under the same parent are
fast-pathed (no QF RPC) as long as the envelope is still in the
registry.

Revocation drops the envelope; subsequent children re-evaluate as new
parents via the gate RPC.

Idempotency: ``revoke`` on an unknown envelope_id returns False without
raising — the gate-RPC handler converts that to ``envelope_unknown``
which QF treats as success per §3.5.

QF-314.
"""

from __future__ import annotations


class EnvelopeRegistry:
    """Plain-Python in-memory set of approved envelope ids.

    Thread-safety: the plugin runs inside NT's async event loop, so all
    accesses are serialized on the loop; no lock is needed. If a future
    integration shares the registry across threads, wrap each method
    in a Lock at construction.
    """

    def __init__(self) -> None:
        self._envelopes: set[str] = set()

    def add(self, envelope_id: str) -> None:
        """Register an approved envelope id from a GateResponse."""
        if not envelope_id:
            return
        self._envelopes.add(envelope_id)

    def contains(self, envelope_id: str) -> bool:
        return envelope_id in self._envelopes

    def revoke(self, envelope_id: str) -> bool:
        """Drop the envelope. Returns True if it was present, False otherwise.

        The gate-RPC handler returns the corresponding RevokeResponse
        status:
          - True  → ``revoked``
          - False → ``envelope_unknown`` (idempotent — restart replay
                    safe)
        """
        if envelope_id in self._envelopes:
            self._envelopes.remove(envelope_id)
            return True
        return False

    def size(self) -> int:
        return len(self._envelopes)

    def clear(self) -> None:
        """Drop every envelope. Used on plugin shutdown + bundle restart."""
        self._envelopes.clear()
