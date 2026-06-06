//! `PyO3` bindings for `qf-quant`.
//!
//! Gated behind the `python` feature so pure-Rust consumers don't pull in
//! `CPython` linkage. Built with `maturin build --features python` into a wheel
//! that exposes a `qf_quant` Python module.
//!
//! # Surface
//!
//! Every scalar in [`crate::normal`], [`crate::bs`], [`crate::black76`], and
//! [`crate::futures_specs`] is wrapped one-to-one. Option kind is passed as a
//! string `"call"` / `"put"`; the wrapper validates and forwards to the Rust
//! [`OptionType`](crate::bs::OptionType) enum. `implied_vol` returns
//! `Option<f64>` which maps naturally to Python `None`.
//!
//! Plus one **batch** kernel, `price_chain`, that takes a Python list of
//! strikes and returns paired `(calls, puts)` lists. The batch kernel
//! releases the GIL via [`Python::detach`] so other Python threads can run
//! concurrently while the chain prices — this is the kernel the GIL-release
//! contract from [`docs/polyglot-migration-tdd.md`] §8.1.1 anchors against.
//!
//! [`docs/polyglot-migration-tdd.md`]: ../../../../docs/polyglot-migration-tdd.md

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyModule;

use crate::bs::OptionType;
use crate::{black76, bs, futures_specs, normal};

fn parse_kind(s: &str) -> PyResult<OptionType> {
    match s {
        "call" | "Call" | "CALL" => Ok(OptionType::Call),
        "put" | "Put" | "PUT" => Ok(OptionType::Put),
        other => Err(PyValueError::new_err(format!(
            "kind must be 'call' or 'put', got {other:?}",
        ))),
    }
}

// ── normal ───────────────────────────────────────────────────────────────

#[pyfunction]
#[pyo3(name = "cdf_correct")]
fn normal_cdf_correct(x: f64) -> f64 {
    normal::cdf_correct(x)
}

#[pyfunction]
#[pyo3(name = "pdf")]
fn normal_pdf(x: f64) -> f64 {
    normal::pdf(x)
}

// ── bs ───────────────────────────────────────────────────────────────────

#[pyfunction]
#[pyo3(signature = (s, k, r, t, v))]
fn bs_call(s: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    bs::call(s, k, r, t, v)
}

#[pyfunction]
#[pyo3(signature = (s, k, r, t, v))]
fn bs_put(s: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    bs::put(s, k, r, t, v)
}

#[pyfunction]
#[pyo3(signature = (s, k, r, t, v, kind))]
fn bs_delta(s: f64, k: f64, r: f64, t: f64, v: f64, kind: &str) -> PyResult<f64> {
    Ok(bs::delta(s, k, r, t, v, parse_kind(kind)?))
}

#[pyfunction]
#[pyo3(signature = (s, k, r, t, v))]
fn bs_gamma(s: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    bs::gamma(s, k, r, t, v)
}

#[pyfunction]
#[pyo3(signature = (s, k, r, t, v, kind))]
fn bs_theta(s: f64, k: f64, r: f64, t: f64, v: f64, kind: &str) -> PyResult<f64> {
    Ok(bs::theta(s, k, r, t, v, parse_kind(kind)?))
}

#[pyfunction]
#[pyo3(signature = (s, k, r, t, v))]
fn bs_vega(s: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    bs::vega(s, k, r, t, v)
}

#[pyfunction]
#[pyo3(signature = (s, k, r, t, market_price, kind))]
fn bs_implied_vol(
    s: f64,
    k: f64,
    r: f64,
    t: f64,
    market_price: f64,
    kind: &str,
) -> PyResult<Option<f64>> {
    Ok(bs::implied_vol(s, k, r, t, market_price, parse_kind(kind)?))
}

// ── black76 ──────────────────────────────────────────────────────────────

#[pyfunction]
#[pyo3(signature = (f, k, r, t, v))]
fn black76_call(f: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    black76::call(f, k, r, t, v)
}

#[pyfunction]
#[pyo3(signature = (f, k, r, t, v))]
fn black76_put(f: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    black76::put(f, k, r, t, v)
}

#[pyfunction]
#[pyo3(signature = (f, k, r, t, v, kind))]
fn black76_delta(f: f64, k: f64, r: f64, t: f64, v: f64, kind: &str) -> PyResult<f64> {
    Ok(black76::delta(f, k, r, t, v, parse_kind(kind)?))
}

#[pyfunction]
#[pyo3(signature = (f, k, r, t, v))]
fn black76_gamma(f: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    black76::gamma(f, k, r, t, v)
}

#[pyfunction]
#[pyo3(signature = (f, k, r, t, v, kind))]
fn black76_theta(f: f64, k: f64, r: f64, t: f64, v: f64, kind: &str) -> PyResult<f64> {
    Ok(black76::theta(f, k, r, t, v, parse_kind(kind)?))
}

#[pyfunction]
#[pyo3(signature = (f, k, r, t, v))]
fn black76_vega(f: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    black76::vega(f, k, r, t, v)
}

#[pyfunction]
#[pyo3(signature = (f, k, r, t, market_price, kind))]
fn black76_implied_vol(
    f: f64,
    k: f64,
    r: f64,
    t: f64,
    market_price: f64,
    kind: &str,
) -> PyResult<Option<f64>> {
    Ok(black76::implied_vol(
        f,
        k,
        r,
        t,
        market_price,
        parse_kind(kind)?,
    ))
}

// ── futures_specs ────────────────────────────────────────────────────────

#[pyfunction]
#[pyo3(name = "futures_root")]
fn futures_specs_root(symbol: &str) -> String {
    futures_specs::futures_root(symbol).to_string()
}

#[pyfunction]
#[pyo3(name = "is_futures_symbol")]
fn futures_specs_is_futures(symbol: &str) -> bool {
    futures_specs::is_futures_symbol(symbol)
}

/// `(root, name, multiplier, tick_size, tick_value, unit, exchange)` tuple
/// or `None` if the symbol's root isn't in the table. Tuples are `PyO3`'s
/// cheapest cross-language carrier; the Python smoke test wraps this back
/// into a dict for ergonomics.
#[pyfunction]
#[pyo3(name = "get_futures_spec")]
#[allow(clippy::type_complexity)]
fn futures_specs_get(symbol: &str) -> Option<(String, String, f64, f64, f64, String, String)> {
    futures_specs::get_futures_spec(symbol).map(|s| {
        (
            s.root.to_string(),
            s.name.to_string(),
            s.multiplier,
            s.tick_size,
            s.tick_value,
            s.unit.to_string(),
            s.exchange.to_string(),
        )
    })
}

// ── batch — the GIL-release anchor ───────────────────────────────────────

/// Price an option chain on `strikes` in one call. Returns `(call_prices,
/// put_prices)` as two lists of `f64`.
///
/// **Releases the GIL** for the whole loop via [`Python::detach`] so other
/// Python threads run concurrently with the chain pricing — this is the
/// kernel the GIL-release contract from
/// [`docs/polyglot-migration-tdd.md`] §8.1.1 anchors against.
#[pyfunction]
#[pyo3(name = "bs_price_chain")]
// PyO3's FromPyObject impl needs an owned Vec — there's no zero-copy
// view from a Python list to &[f64] without numpy. Allow the lint.
#[allow(clippy::needless_pass_by_value)]
fn bs_price_chain(
    py: Python<'_>,
    spot: f64,
    strikes: Vec<f64>,
    r: f64,
    t: f64,
    v: f64,
) -> (Vec<f64>, Vec<f64>) {
    py.detach(|| {
        let mut calls = Vec::with_capacity(strikes.len());
        let mut puts = Vec::with_capacity(strikes.len());
        for &k in &strikes {
            calls.push(bs::call(spot, k, r, t, v));
            puts.push(bs::put(spot, k, r, t, v));
        }
        (calls, puts)
    })
}

// ── module entry point ──────────────────────────────────────────────────

/// `PyO3` module entry. The name `qf_quant` must match the
/// `[lib].name` in `Cargo.toml`, the wheel filename, and the Python `import`
/// statement.
#[pymodule]
fn qf_quant(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(normal_cdf_correct, m)?)?;
    m.add_function(wrap_pyfunction!(normal_pdf, m)?)?;

    m.add_function(wrap_pyfunction!(bs_call, m)?)?;
    m.add_function(wrap_pyfunction!(bs_put, m)?)?;
    m.add_function(wrap_pyfunction!(bs_delta, m)?)?;
    m.add_function(wrap_pyfunction!(bs_gamma, m)?)?;
    m.add_function(wrap_pyfunction!(bs_theta, m)?)?;
    m.add_function(wrap_pyfunction!(bs_vega, m)?)?;
    m.add_function(wrap_pyfunction!(bs_implied_vol, m)?)?;

    m.add_function(wrap_pyfunction!(black76_call, m)?)?;
    m.add_function(wrap_pyfunction!(black76_put, m)?)?;
    m.add_function(wrap_pyfunction!(black76_delta, m)?)?;
    m.add_function(wrap_pyfunction!(black76_gamma, m)?)?;
    m.add_function(wrap_pyfunction!(black76_theta, m)?)?;
    m.add_function(wrap_pyfunction!(black76_vega, m)?)?;
    m.add_function(wrap_pyfunction!(black76_implied_vol, m)?)?;

    m.add_function(wrap_pyfunction!(futures_specs_root, m)?)?;
    m.add_function(wrap_pyfunction!(futures_specs_is_futures, m)?)?;
    m.add_function(wrap_pyfunction!(futures_specs_get, m)?)?;

    m.add_function(wrap_pyfunction!(bs_price_chain, m)?)?;

    Ok(())
}
