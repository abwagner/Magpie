//! `qf-logging` — `Magpie` structured-logging helper for Rust.
//!
//! Installs a `tracing-subscriber` layer that emits JSON conforming to the
//! common log schema in [`docs/tdd/observability.md`] §3. Provides a
//! `with_correlation_id` helper that propagates the correlation ID through
//! synchronous call stacks via a thread-local.
//!
//! [`docs/tdd/observability.md`]: ../../../../docs/tdd/observability.md
//!
//! # Schema emitted
//!
//! ```json
//! {
//!   "ts": "2026-05-13T15:04:05.123456Z",
//!   "level": "info",
//!   "service": "qf-quant",
//!   "correlation_id": "01J5V6W2H3R5T7Y9Z1B3D5F7H9",
//!   "event": "bs.delta_computed",
//!   "payload": { "spot": 100.0, "iv": 0.2 }
//! }
//! ```
//!
//! Fields are emitted in the order shown; `correlation_id` is omitted when
//! no `with_correlation_id` context is active (and a `system.correlation_id.missing`
//! warning is logged once per call site at debug level — left to the
//! component to enforce per migration TDD §4.2).
//!
//! # Usage
//!
//! ```rust,no_run
//! use qf_logging::{init, with_correlation_id};
//!
//! fn main() {
//!     init("qf-example");
//!     with_correlation_id("01J5V6W2H3R5T7Y9Z1B3D5F7H9", || {
//!         tracing::info!(event = "service.started", port = 8080);
//!     });
//! }
//! ```
//!
//! Use the standard `tracing` macros (`debug!`, `info!`, `warn!`, `error!`)
//! with two well-known field names:
//!
//! - `event` — the dot-namespaced event identifier (e.g. `"bs.delta_computed"`).
//! - any other named fields become the `payload` object on the JSON line.
//!
//! # Async note
//!
//! v1 propagates correlation IDs through `thread_local!`, which works for
//! synchronous call stacks. Async code that crosses `.await` boundaries
//! needs a Tokio task-local; that's a planned v2 enhancement. `PyO3` entry
//! points pass `correlation_id: &str` explicitly per migration TDD §4.3,
//! which sidesteps the issue.

use std::cell::RefCell;
use std::fmt::Write as _;
use std::io::{self, Write};
use std::sync::OnceLock;

use serde_json::{json, Map, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt as _};
use tracing_subscriber::registry::Registry;
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::Layer;

thread_local! {
    static CORRELATION_ID: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Service name embedded in every emitted log line. Set once at `init` time.
static SERVICE: OnceLock<String> = OnceLock::new();

/// Install the global tracing subscriber. Idempotent: subsequent calls are
/// no-ops and the first `service` wins. Returns `Err` if a subscriber was
/// already installed by some other crate.
///
/// # Errors
///
/// Returns the subscriber-init error if another global subscriber is
/// already in place.
pub fn init(service: &str) -> Result<(), tracing_subscriber::util::TryInitError> {
    let _ = SERVICE.set(service.to_owned());
    Registry::default().with(QfJsonLayer).try_init()
}

/// Run `f` with `correlation_id` bound on the current thread. Restores the
/// prior value (if any) on return.
pub fn with_correlation_id<F, R>(correlation_id: &str, f: F) -> R
where
    F: FnOnce() -> R,
{
    let owned = correlation_id.to_owned();
    let prior = CORRELATION_ID.with(|c| c.borrow_mut().replace(owned));
    let result = f();
    CORRELATION_ID.with(|c| {
        *c.borrow_mut() = prior;
    });
    result
}

/// Read the correlation ID bound by an enclosing `with_correlation_id`,
/// if any.
#[must_use]
pub fn current_correlation_id() -> Option<String> {
    CORRELATION_ID.with(|c| c.borrow().clone())
}

// ── Internal: tracing layer that formats events as framework JSON ──────────

struct QfJsonLayer;

impl<S: Subscriber> Layer<S> for QfJsonLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let level = *event.metadata().level();
        let line = format_line(level, visitor);
        // Errors are written to stderr in the framework spec; everything else
        // to stdout. Per observability.md §6.1 and to keep the operator-
        // facing error stream isolated for tooling like `tee` + alerting.
        if level == Level::ERROR {
            let _ = writeln!(io::stderr(), "{line}");
        } else {
            let _ = writeln!(io::stdout(), "{line}");
        }
    }
}

#[derive(Default)]
struct FieldVisitor {
    event: Option<String>,
    payload: Map<String, Value>,
    error: Option<Value>,
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let mut s = String::new();
        let _ = write!(s, "{value:?}");
        self.set(field.name(), Value::String(s));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.set(field.name(), Value::String(value.to_owned()));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.set(field.name(), json!(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.set(field.name(), json!(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.set(field.name(), json!(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.set(field.name(), Value::Bool(value));
    }
}

impl FieldVisitor {
    fn set(&mut self, name: &str, value: Value) {
        match name {
            "event" => {
                if let Value::String(s) = value {
                    self.event = Some(s);
                }
            }
            "error" => self.error = Some(value),
            // `message` is what `tracing::info!("text")` produces under the
            // hood; treat it like an event name if `event` wasn't set
            // explicitly. Keeps untargeted log lines workable while still
            // emitting the framework schema.
            "message" => {
                if self.event.is_none() {
                    if let Value::String(s) = value {
                        self.event = Some(s);
                    }
                }
            }
            _ => {
                self.payload.insert(name.to_owned(), value);
            }
        }
    }
}

fn format_line(level: Level, fields: FieldVisitor) -> String {
    let ts = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned());
    let service = SERVICE
        .get()
        .cloned()
        .unwrap_or_else(|| "unknown".to_owned());
    let level_str = if level == Level::TRACE {
        "trace"
    } else if level == Level::DEBUG {
        "debug"
    } else if level == Level::INFO {
        "info"
    } else if level == Level::WARN {
        "warn"
    } else {
        "error"
    };
    let event = fields.event.unwrap_or_else(|| "anonymous".to_owned());

    // Build the JSON object preserving framework field order for human
    // greppability. serde_json::Value preserves insertion order with the
    // `preserve_order` feature; we don't enable it for build-size reasons,
    // so we build the line via a flat manual emitter.
    let mut out = String::with_capacity(256);
    out.push('{');
    write_kv(&mut out, "ts", &Value::String(ts), true);
    write_kv(
        &mut out,
        "level",
        &Value::String(level_str.to_owned()),
        false,
    );
    write_kv(&mut out, "service", &Value::String(service), false);
    if let Some(cid) = current_correlation_id() {
        write_kv(&mut out, "correlation_id", &Value::String(cid), false);
    }
    write_kv(&mut out, "event", &Value::String(event), false);
    let payload = Value::Object(fields.payload);
    write_kv(&mut out, "payload", &payload, false);
    if let Some(err) = fields.error {
        write_kv(&mut out, "error", &err, false);
    }
    out.push('}');
    out
}

fn write_kv(buf: &mut String, key: &str, value: &Value, first: bool) {
    if !first {
        buf.push(',');
    }
    // Keys are well-known ASCII; safe to push without escaping.
    buf.push('"');
    buf.push_str(key);
    buf.push_str("\":");
    let s = serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned());
    buf.push_str(&s);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_correlation_id_round_trips() {
        assert!(current_correlation_id().is_none());
        with_correlation_id("01ABCDEFGH1JK2MNPQRSTVWXYZ", || {
            assert_eq!(
                current_correlation_id().as_deref(),
                Some("01ABCDEFGH1JK2MNPQRSTVWXYZ")
            );
        });
        assert!(current_correlation_id().is_none());
    }

    #[test]
    fn with_correlation_id_restores_prior_value() {
        with_correlation_id("outer", || {
            with_correlation_id("inner", || {
                assert_eq!(current_correlation_id().as_deref(), Some("inner"));
            });
            assert_eq!(current_correlation_id().as_deref(), Some("outer"));
        });
    }

    #[test]
    fn format_line_emits_required_fields() {
        let _ = SERVICE.set("test-service".to_owned());
        let mut visitor = FieldVisitor::default();
        visitor.set("event", Value::String("bs.delta_computed".to_owned()));
        visitor.set("spot", json!(100.0));
        visitor.set("iv", json!(0.2));
        let line = format_line(Level::INFO, visitor);
        let parsed: Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(parsed["level"], "info");
        assert_eq!(parsed["service"], "test-service");
        assert_eq!(parsed["event"], "bs.delta_computed");
        assert_eq!(parsed["payload"]["spot"], 100.0);
        assert_eq!(parsed["payload"]["iv"], 0.2);
        assert!(parsed["ts"].as_str().unwrap().contains('T'));
    }

    #[test]
    fn format_line_includes_correlation_id_when_set() {
        let _ = SERVICE.set("test-service".to_owned());
        let line = with_correlation_id("01TESTCORRELATION12345", || {
            let mut visitor = FieldVisitor::default();
            visitor.set("event", Value::String("smoke".to_owned()));
            format_line(Level::INFO, visitor)
        });
        let parsed: Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(parsed["correlation_id"], "01TESTCORRELATION12345");
    }
}
