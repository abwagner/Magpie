//! Standard normal CDF and PDF (Abramowitz & Stegun 7.1.26).
//!
//! [`cdf_correct`] is the A&S 7.1.26 approximation with the `z = x/√2`
//! substitution applied throughout. Max absolute error vs textbook Φ is
//! ~7.5e-8. Every BS / Black-76 / IV path in this crate routes through it.
//!
//! Phase 1 originally shipped a bug-for-bug variant named `cdf` alongside
//! this one (per [`docs/polyglot-migration-tdd.md`] §8.1.1.1) so the Rust
//! port stayed equivalent to the legacy JS impl during Phase 1.5
//! re-calibration; QF-140 removed it as the Phase 6 decommissioning step.
//!
//! [`docs/polyglot-migration-tdd.md`]: ../../../../docs/polyglot-migration-tdd.md
//!
//! All math is `f64` per the workspace convention.

// Abramowitz & Stegun 7.1.26 coefficients for `erf(z)` on z ≥ 0.
//
// erf(z) ≈ 1 - ((((a5·t + a4)·t + a3)·t + a2)·t + a1)·t · exp(-z²)
// where t = 1 / (1 + p·z).
//
// |error| < 7.5e-8 for z ≥ 0.
const A1: f64 = 0.254_829_592;
const A2: f64 = -0.284_496_736;
const A3: f64 = 1.421_413_741;
const A4: f64 = -1.453_152_027;
const A5: f64 = 1.061_405_429;
const P: f64 = 0.327_591_1;

/// Standard normal PDF: `φ(x) = exp(-x²/2) / √(2π)`.
///
/// Ports `src/lib/bs.js:20` (the `n(x)` helper). Bug-free in the JS, so
/// no two-implementation split needed.
#[must_use]
pub fn pdf(x: f64) -> f64 {
    (-x * x / 2.0).exp() / std::f64::consts::TAU.sqrt()
}

/// Standard normal CDF using the real A&S 7.1.26 approximation of `erf`
/// composed with the change of variable `z = x/√2`.
///
/// `Φ(x) = ½·(1 + erf(x/√2))`. Max absolute error vs textbook Φ is
/// approximately 7.5e-8. This is what every Phase 1.5+ caller should
/// use.
#[must_use]
pub fn cdf_correct(x: f64) -> f64 {
    let z = x / std::f64::consts::SQRT_2;
    0.5 * (1.0 + erf_as_7_1_26(z))
}

/// `erf(z)` via Abramowitz & Stegun 7.1.26. `|error| < 7.5e-8` for any `z`.
fn erf_as_7_1_26(z: f64) -> f64 {
    let s = if z < 0.0 { -1.0_f64 } else { 1.0_f64 };
    let abs_z = z.abs();
    let t = 1.0 / (1.0 + P * abs_z);
    let poly = ((((A5 * t + A4) * t + A3) * t + A2) * t + A1) * t;
    s * (1.0 - poly * (-abs_z * abs_z).exp())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TS_PARITY_TOL: f64 = 1e-9;
    const AS_MAX_ERROR: f64 = 7.5e-8;

    // φ(0) = 1/√(2π). Symmetric around 0.
    const PDF_JS_REF: &[(f64, f64)] = &[
        (0.0, 0.398_942_280_401_432_7),
        (0.5, 0.352_065_326_764_299_5),
        (1.0, 0.241_970_724_519_143_36),
        (1.96, 0.058_440_944_333_451_48),
        (3.0, 0.004_431_848_411_938_008),
        (5.0, 0.000_001_486_719_514_734),
    ];

    // Textbook Φ values to spot-check cdf_correct against. Sources:
    // standard normal tables / scipy.stats.norm.cdf.
    const CDF_TEXTBOOK: &[(f64, f64)] = &[
        (-1.96, 0.024_997_895_148_220_47),
        (-1.0, 0.158_655_253_931_457_05),
        (-0.5, 0.308_537_538_725_987_03),
        (0.0, 0.5),
        (0.5, 0.691_462_461_274_013),
        (1.0, 0.841_344_746_068_543),
        (1.96, 0.975_002_104_851_779_5),
        (3.0, 0.998_650_101_968_369_9),
    ];

    #[test]
    fn pdf_matches_js() {
        for &(x, expected) in PDF_JS_REF {
            let got = pdf(x);
            assert!(
                (got - expected).abs() < TS_PARITY_TOL,
                "pdf({x}) = {got}, expected {expected}",
            );
            // Symmetry: φ(-x) = φ(x).
            let got_neg = pdf(-x);
            assert!(
                (got_neg - expected).abs() < TS_PARITY_TOL,
                "pdf({}) = {got_neg}, expected {expected} (symmetry)",
                -x,
            );
        }
    }

    #[test]
    fn cdf_correct_matches_textbook() {
        for &(x, expected) in CDF_TEXTBOOK {
            let got = cdf_correct(x);
            assert!(
                (got - expected).abs() < AS_MAX_ERROR,
                "cdf_correct({x}) = {got}, expected {expected} (|diff| {})",
                (got - expected).abs(),
            );
        }
    }

    #[test]
    fn cdf_correct_symmetry() {
        // Φ(-x) = 1 - Φ(x) exactly (within fp noise).
        let xs = [-3.0_f64, -1.5, -0.25, 0.25, 1.5, 3.0];
        for x in xs {
            let lhs = cdf_correct(-x);
            let rhs = 1.0 - cdf_correct(x);
            assert!(
                (lhs - rhs).abs() < 1e-12,
                "cdf_correct symmetry broken at x={x}: cdf_correct(-x)={lhs}, 1-cdf_correct(x)={rhs}",
            );
        }
    }

    #[test]
    fn cdf_correct_asymptotics() {
        // Saturates at the tails; pins to 0.5 at x=0.
        assert!(cdf_correct(-10.0).abs() < 1e-9);
        assert!((cdf_correct(10.0) - 1.0).abs() < 1e-9);
        assert!((cdf_correct(0.0) - 0.5).abs() < 1e-9);
    }
}
