#!/usr/bin/env node
// Parity harness — emits the same fixed log line as the Rust and Python
// harnesses for the cross-runtime golden test in
// research/tests/test_logging_parity.py.
//
// LOG_FORMAT=json must be set before the logger module loads because
// the PRETTY constant is computed at module-load time. Set it here
// then dynamic-import so the script is self-contained (the parity test
// can `npx tsx scripts/log-parity-harness.ts` without env wrangling).

process.env.LOG_FORMAT = "json";

const { createLogger, withCorrelationId } = await import("../server/logger.js");

const log = createLogger("parity-test", "trace");

withCorrelationId("01PARITYHARNESS0000000000A", () => {
  log.info("parity.smoke", { answer: 42, label: "fixed" });
});
