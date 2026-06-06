//! Parity harness — emits one fixed log line for the cross-runtime
//! golden test in `research/tests/test_logging_parity.py`.
//!
//! Outputs a single info-level event with a known `correlation_id`, event
//! name, and payload. The cross-runtime test runs this and the equivalent
//! TS / Python harnesses and asserts the parsed JSON is identical modulo
//! the `ts` field.

fn main() {
    qf_logging::init("parity-test").expect("subscriber should install");
    qf_logging::with_correlation_id("01PARITYHARNESS0000000000A", || {
        tracing::info!(event = "parity.smoke", answer = 42, label = "fixed");
    });
}
