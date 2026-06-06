"""Parity harness — emits the same fixed log line as the Rust and TS
harnesses for the cross-runtime golden test in
``research/tests/test_logging_parity.py``."""

from __future__ import annotations

from quantfoundry_logging import get_logger, with_correlation_id


def main() -> None:
    logger = get_logger("parity-test")
    with with_correlation_id("01PARITYHARNESS0000000000A"):
        logger.info("parity.smoke", answer=42, label="fixed")


if __name__ == "__main__":
    main()
