//! Criterion bench harness for `qf-quant`.
//!
//! Three groups, mirroring how the math is actually called in practice:
//!
//! - `normal` — `cdf_correct` / `pdf` at the values BS/Black-76
//!   pricing hits in the inner loop.
//! - `single_option` — `bs::*` and `black76::*` for one ATM option.
//!   Microbenchmark; JIT inlines the JS version aggressively in this
//!   regime so this is where Rust *loses* on per-call latency.
//! - `chain` — 100-strike option chain priced + Greeks. Closer to the
//!   real workload (a vol surface tick, a single-trial backtest fold).
//!   Where Rust's no-GC + cache-friendly loop pulls ahead.
//!
//! `bs::implied_vol` is sampled separately — the bisection drives a
//! ~100-iteration loop, very different cost profile from a single
//! pricing call.
//!
//! Run with `cargo bench -p qf-quant`. Numbers feed
//! `docs/polyglot-migration-tdd.md` §8.1.1.2.

use criterion::{criterion_group, criterion_main, Criterion};
use qf_quant::bs::{self, OptionType};
use qf_quant::{black76, normal};
use std::hint::black_box;

const ATM: f64 = 100.0;
const STRIKE: f64 = 100.0;
const RFR: f64 = 0.05;
const TTM: f64 = 0.25;
const VOL: f64 = 0.20;

fn bench_normal(c: &mut Criterion) {
    let mut g = c.benchmark_group("normal");
    // Single-call cost: the values d1/d2 in BS at ATM are ~0.2.
    g.bench_function("cdf_correct", |b| {
        b.iter(|| normal::cdf_correct(black_box(0.2)));
    });
    g.bench_function("pdf", |b| b.iter(|| normal::pdf(black_box(0.2))));
    g.finish();
}

fn bench_bs_single(c: &mut Criterion) {
    let mut g = c.benchmark_group("single_option");
    // BS — what hits the wire when sizing a single position.
    g.bench_function("bs::call", |b| {
        b.iter(|| {
            bs::call(
                black_box(ATM),
                black_box(STRIKE),
                black_box(RFR),
                black_box(TTM),
                black_box(VOL),
            )
        });
    });
    g.bench_function("bs::put", |b| {
        b.iter(|| {
            bs::put(
                black_box(ATM),
                black_box(STRIKE),
                black_box(RFR),
                black_box(TTM),
                black_box(VOL),
            )
        });
    });
    g.bench_function("bs::delta", |b| {
        b.iter(|| {
            bs::delta(
                black_box(ATM),
                black_box(STRIKE),
                black_box(RFR),
                black_box(TTM),
                black_box(VOL),
                OptionType::Call,
            )
        });
    });
    g.bench_function("bs::gamma", |b| {
        b.iter(|| {
            bs::gamma(
                black_box(ATM),
                black_box(STRIKE),
                black_box(RFR),
                black_box(TTM),
                black_box(VOL),
            )
        });
    });
    g.bench_function("bs::theta", |b| {
        b.iter(|| {
            bs::theta(
                black_box(ATM),
                black_box(STRIKE),
                black_box(RFR),
                black_box(TTM),
                black_box(VOL),
                OptionType::Call,
            )
        });
    });
    g.bench_function("bs::vega", |b| {
        b.iter(|| {
            bs::vega(
                black_box(ATM),
                black_box(STRIKE),
                black_box(RFR),
                black_box(TTM),
                black_box(VOL),
            )
        });
    });
    g.bench_function("bs::implied_vol", |b| {
        // Price first so the solver has a real bracket to walk.
        let market_price = bs::call(ATM, STRIKE, RFR, TTM, VOL);
        b.iter(|| {
            bs::implied_vol(
                black_box(ATM),
                black_box(STRIKE),
                black_box(RFR),
                black_box(TTM),
                black_box(market_price),
                OptionType::Call,
            )
        });
    });

    g.finish();
}

fn bench_black76_single(c: &mut Criterion) {
    let mut g = c.benchmark_group("single_option");
    // Black-76 — futures-options path. Same group label as the BS
    // single-option benches so criterion reports them together.
    g.bench_function("black76::call", |b| {
        b.iter(|| {
            black76::call(
                black_box(ATM),
                black_box(STRIKE),
                black_box(RFR),
                black_box(TTM),
                black_box(VOL),
            )
        });
    });
    g.bench_function("black76::implied_vol", |b| {
        let market_price = black76::call(ATM, STRIKE, RFR, TTM, VOL);
        b.iter(|| {
            black76::implied_vol(
                black_box(ATM),
                black_box(STRIKE),
                black_box(RFR),
                black_box(TTM),
                black_box(market_price),
                OptionType::Call,
            )
        });
    });
    g.finish();
}

fn bench_chain(c: &mut Criterion) {
    // 100-strike chain centered on ATM, step 1.0 — a realistic chain
    // size for, say, ES or SPY options.
    let strikes: Vec<f64> = (0..100).map(|i| 50.0 + f64::from(i)).collect();
    let mut g = c.benchmark_group("chain");

    // Pricing: 200 prices (100 strikes × call + put).
    g.bench_function("price_100_strike_chain", |b| {
        b.iter(|| {
            let mut acc = 0.0_f64;
            for &k in &strikes {
                acc += bs::call(ATM, black_box(k), RFR, TTM, VOL);
                acc += bs::put(ATM, black_box(k), RFR, TTM, VOL);
            }
            black_box(acc)
        });
    });

    // Greeks: delta + gamma + theta + vega per strike, both Call and Put = 800 Greek values.
    // The TDD §8.1.1.2 calls this "400 Greeks" with call-side-only — match that semantic
    // so the comparison row in the doc is meaningful.
    g.bench_function("greeks_100_strike_call_chain", |b| {
        b.iter(|| {
            let mut acc = 0.0_f64;
            for &k in &strikes {
                acc += bs::delta(ATM, black_box(k), RFR, TTM, VOL, OptionType::Call);
                acc += bs::gamma(ATM, black_box(k), RFR, TTM, VOL);
                acc += bs::theta(ATM, black_box(k), RFR, TTM, VOL, OptionType::Call);
                acc += bs::vega(ATM, black_box(k), RFR, TTM, VOL);
            }
            black_box(acc)
        });
    });
    g.finish();
}

criterion_group!(
    benches,
    bench_normal,
    bench_bs_single,
    bench_black76_single,
    bench_chain
);
criterion_main!(benches);
