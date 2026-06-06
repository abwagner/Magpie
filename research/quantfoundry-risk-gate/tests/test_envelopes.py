"""QF-314 — envelope registry unit tests."""

from __future__ import annotations

from quantfoundry_risk_gate.envelopes import EnvelopeRegistry


class TestEnvelopeRegistry:
    def test_add_then_contains(self) -> None:
        r = EnvelopeRegistry()
        r.add("ENV-1")
        assert r.contains("ENV-1")
        assert r.size() == 1

    def test_revoke_present_returns_true_and_drops(self) -> None:
        r = EnvelopeRegistry()
        r.add("ENV-1")
        assert r.revoke("ENV-1") is True
        assert not r.contains("ENV-1")
        assert r.size() == 0

    def test_revoke_unknown_returns_false_idempotent(self) -> None:
        r = EnvelopeRegistry()
        assert r.revoke("NEVER-EXISTED") is False

    def test_double_revoke_idempotent(self) -> None:
        r = EnvelopeRegistry()
        r.add("ENV-2")
        assert r.revoke("ENV-2") is True
        # Second call: envelope is now unknown.
        assert r.revoke("ENV-2") is False

    def test_clear_drops_all(self) -> None:
        r = EnvelopeRegistry()
        r.add("A")
        r.add("B")
        r.add("C")
        r.clear()
        assert r.size() == 0
        assert not r.contains("A")

    def test_empty_envelope_id_ignored(self) -> None:
        r = EnvelopeRegistry()
        r.add("")
        assert r.size() == 0
