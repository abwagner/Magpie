//! Black-Scholes for equity options.
//!
//! Ports the `BS` object in `src/lib/bs.js:93-138` to Rust. After the
//! Phase 1.5 CDF cutover, every CDF reference goes through
//! [`crate::normal::cdf_correct`] (the textbook A&S 7.1.26 with the
//! `z = x/√2` substitution applied throughout). The legacy bug-for-bug
//! [`crate::normal::cdf`] stays in-tree as `#[deprecated]` so external
//! callers still resolve it; Phase 6 removes it.
//!
//! Theta is per-calendar-day (divided by 365) and vega is per-1%-vol
//! (divided by 100), matching the JS conventions.

use crate::iv::bisection;
use crate::normal::{cdf_correct as cdf, pdf};

/// Whether an option is a call or a put.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum OptionType {
    Call,
    Put,
}

#[inline]
fn d1(s: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    ((s / k).ln() + (r + v * v / 2.0) * t) / (v * t.sqrt())
}

#[inline]
fn d2(s: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    d1(s, k, r, t, v) - v * t.sqrt()
}

/// Black-Scholes call price.
#[must_use]
pub fn call(s: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    if t <= 0.0 {
        return (s - k).max(0.0);
    }
    s * cdf(d1(s, k, r, t, v)) - k * (-r * t).exp() * cdf(d2(s, k, r, t, v))
}

/// Black-Scholes put price.
#[must_use]
pub fn put(s: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    if t <= 0.0 {
        return (k - s).max(0.0);
    }
    let big_d1 = d1(s, k, r, t, v);
    let big_d2 = d2(s, k, r, t, v);
    k * (-r * t).exp() * cdf(-big_d2) - s * cdf(-big_d1)
}

/// Δ. At expiry, returns the digital indicator (1/0 for in-/out-of-the-money
/// call; -1/0 for put). Matches the JS `T<=0` branch.
#[must_use]
pub fn delta(s: f64, k: f64, r: f64, t: f64, v: f64, kind: OptionType) -> f64 {
    if t <= 0.0 {
        return match kind {
            OptionType::Call => f64::from(s > k),
            OptionType::Put => -f64::from(s < k),
        };
    }
    let nd1 = cdf(d1(s, k, r, t, v));
    match kind {
        OptionType::Call => nd1,
        OptionType::Put => nd1 - 1.0,
    }
}

/// Γ. Symmetric in call/put.
#[must_use]
pub fn gamma(s: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    pdf(d1(s, k, r, t, v)) / (s * v * t.sqrt())
}

/// Θ per calendar day (annualized model output is divided by 365 to
/// match the JS convention).
#[must_use]
pub fn theta(s: f64, k: f64, r: f64, t: f64, v: f64, kind: OptionType) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    let big_d1 = d1(s, k, r, t, v);
    let big_d2 = d2(s, k, r, t, v);
    let common = -s * pdf(big_d1) * v / (2.0 * t.sqrt());
    let annual = match kind {
        OptionType::Call => common - r * k * (-r * t).exp() * cdf(big_d2),
        OptionType::Put => common + r * k * (-r * t).exp() * cdf(-big_d2),
    };
    annual / 365.0
}

/// Vega per 1% vol point (annualized model output is divided by 100 to
/// match the JS convention).
#[must_use]
pub fn vega(s: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    s * t.sqrt() * pdf(d1(s, k, r, t, v)) / 100.0
}

/// Implied volatility via [`crate::iv::bisection`]. Returns `None` when
/// the market price sits outside the no-arbitrage bracket
/// `(intrinsic, max_price)`, matching the JS guards.
#[must_use]
pub fn implied_vol(
    s: f64,
    k: f64,
    r: f64,
    t: f64,
    market_price: f64,
    kind: OptionType,
) -> Option<f64> {
    if t <= 0.0 {
        return None;
    }
    let intrinsic = match kind {
        OptionType::Call => (s - k * (-r * t).exp()).max(0.0),
        OptionType::Put => (k * (-r * t).exp() - s).max(0.0),
    };
    let max_price = match kind {
        OptionType::Call => s,
        OptionType::Put => k * (-r * t).exp(),
    };
    let price_fn = |v: f64| match kind {
        OptionType::Call => call(s, k, r, t, v),
        OptionType::Put => put(s, k, r, t, v),
    };
    bisection(price_fn, market_price, intrinsic, max_price)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tolerance budget after the Phase 1.5 cutover. Rust uses
    // `cdf_correct` (A&S 7.1.26, max |err| vs textbook Φ ≈ 7.5e-8).
    // Scipy uses a higher-precision erf under the hood. The error in
    // Φ propagates through BS as roughly `S × err`, so for our test
    // grid (S ≤ 110) the worst-case absolute discrepancy on prices is
    // ~1.3e-5. 5e-5 gives modest headroom without going so wide that
    // the test stops catching gross regressions. A future ticket can
    // swap A&S 7.1.26 for libm's `erf` to tighten this to ~1e-12.
    const SCIPY_PARITY_TOL: f64 = 5e-5;

    // Reference values computed against scipy.stats.norm.cdf for the
    // textbook Black-Scholes formulas. These replace the pre-cutover
    // JS-anchored bug-for-bug values; the JS values now live as
    // documented divergences in the equivalence harness
    // (`tests/fixtures/equivalence_v1/expected_divergence.toml`
    // `[cdf-correction.functions]` section).
    //
    // Tuple layout: (S, K, r, T, v, call, put, delta_c, delta_p, gamma,
    //                theta_c, theta_p, vega).
    const BS_TEXTBOOK_REF: &[(
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
    )] = &[
        (
            100.0,
            100.0,
            0.05,
            0.25,
            0.2,
            4.614_997_129_602_855,
            3.372_777_178_991_008,
            0.569_460_183_207_673_7,
            -0.430_539_816_792_326_34,
            0.039_288_000_944_737_93,
            -0.028_696_304_790_426_883,
            -0.015_167_841_769_962_751,
            0.196_440_004_723_689_67,
        ),
        (
            100.0,
            100.0,
            0.05,
            1.0,
            0.2,
            10.450_583_572_185_565,
            5.573_526_022_256_971,
            0.636_830_651_175_619_1,
            -0.363_169_348_824_380_9,
            0.018_762_017_345_846_895,
            -0.017_572_678_209_419_72,
            -0.004_542_138_147_766_099,
            0.375_240_346_916_937_9,
        ),
        (
            110.0,
            100.0,
            0.05,
            0.25,
            0.2,
            11.988_329_524_461_037,
            0.746_109_573_849_176_8,
            0.870_361_535_055_297_8,
            -0.129_638_464_944_702_21,
            0.019_194_324_561_949_087,
            -0.024_198_900_028_966_48,
            -0.010_670_437_008_502_351,
            0.116_125_663_599_792,
        ),
        (
            90.0,
            100.0,
            0.05,
            0.25,
            0.2,
            0.897_521_820_529_554_8,
            9.655_301_869_917_707,
            0.189_807_699_453_723_83,
            -0.810_192_300_546_276_1,
            0.030_132_931_933_738_616,
            -0.015_591_215_150_084_754,
            -0.002_062_752_129_620_626_5,
            0.122_038_374_331_641_4,
        ),
        (
            100.0,
            100.0,
            0.0,
            0.25,
            0.2,
            3.987_761_167_674_492,
            3.987_761_167_674_492,
            0.519_938_805_838_372_5,
            -0.480_061_194_161_627_5,
            0.039_844_391_409_476_404,
            -0.021_832_543_238_069_26,
            -0.021_832_543_238_069_26,
            0.199_221_957_047_382,
        ),
        (
            100.0,
            100.0,
            0.05,
            0.25,
            0.5,
            10.519_259_462_543_722,
            9.277_039_511_931_875,
            0.569_460_183_207_673_7,
            -0.430_539_816_792_326_34,
            0.015_715_200_377_895_172,
            -0.060_179_009_356_931_91,
            -0.046_650_546_336_467_78,
            0.196_440_004_723_689_67,
        ),
        (
            100.0,
            100.0,
            0.05,
            0.25,
            0.05,
            1.733_610_832_523_012_8,
            0.491_390_881_911_151_2,
            0.695_849_439_847_120_1,
            -0.304_150_560_152_879_9,
            0.139_937_779_111_826_3,
            -0.014_087_092_867_143_231,
            -0.000_558_629_846_679_102,
            0.174_922_223_889_782_9,
        ),
        (
            100.0,
            100.0,
            0.05,
            0.01,
            0.2,
            0.822_914_847_165_158_4,
            0.772_927_345_082_095_5,
            0.513_960_129_562_758_3,
            -0.486_039_870_437_241_73,
            0.199_349_001_536_127_86,
            -0.116_160_151_267_619_47,
            -0.102_468_368_733_658_26,
            0.039_869_800_307_225_575,
        ),
    ];

    fn assert_close(got: f64, want: f64, label: &str, inputs: (f64, f64, f64, f64, f64)) {
        let diff = (got - want).abs();
        assert!(
            diff < SCIPY_PARITY_TOL,
            "{label} mismatch at inputs={inputs:?}: got={got}, want={want}, |diff|={diff}",
        );
    }

    #[test]
    fn bs_matches_textbook_at_grid() {
        for &(
            s,
            k,
            r,
            t,
            v,
            call_ref,
            put_ref,
            delta_c_ref,
            delta_p_ref,
            gamma_ref,
            theta_c_ref,
            theta_p_ref,
            vega_ref,
        ) in BS_TEXTBOOK_REF
        {
            let inputs = (s, k, r, t, v);
            assert_close(call(s, k, r, t, v), call_ref, "call", inputs);
            assert_close(put(s, k, r, t, v), put_ref, "put", inputs);
            assert_close(
                delta(s, k, r, t, v, OptionType::Call),
                delta_c_ref,
                "delta_call",
                inputs,
            );
            assert_close(
                delta(s, k, r, t, v, OptionType::Put),
                delta_p_ref,
                "delta_put",
                inputs,
            );
            assert_close(gamma(s, k, r, t, v), gamma_ref, "gamma", inputs);
            assert_close(
                theta(s, k, r, t, v, OptionType::Call),
                theta_c_ref,
                "theta_call",
                inputs,
            );
            assert_close(
                theta(s, k, r, t, v, OptionType::Put),
                theta_p_ref,
                "theta_put",
                inputs,
            );
            assert_close(vega(s, k, r, t, v), vega_ref, "vega", inputs);
        }
    }

    #[test]
    fn put_call_parity_holds() {
        // C - P = S - K·exp(-rT) holds bit-exactly post-cutover because
        // both sides go through the same `cdf_correct` and the bias
        // cancels in the difference.
        for &(s, k, r, t, v, ..) in BS_TEXTBOOK_REF {
            let lhs = call(s, k, r, t, v) - put(s, k, r, t, v);
            let rhs = s - k * (-r * t).exp();
            assert!(
                (lhs - rhs).abs() < 1e-10,
                "parity violated at S={s} K={k} r={r} T={t} v={v}: {lhs} vs {rhs}",
            );
        }
    }

    #[test]
    fn at_expiry_returns_intrinsic() {
        // T<=0 branch returns max(S-K, 0) for calls / max(K-S, 0) for puts,
        // with delta as the digital indicator.
        assert!((call(110.0, 100.0, 0.05, 0.0, 0.2) - 10.0).abs() < f64::EPSILON);
        assert!((put(90.0, 100.0, 0.05, 0.0, 0.2) - 10.0).abs() < f64::EPSILON);
        assert!((call(90.0, 100.0, 0.05, 0.0, 0.2)).abs() < f64::EPSILON);
        assert!((put(110.0, 100.0, 0.05, 0.0, 0.2)).abs() < f64::EPSILON);
        assert!((delta(110.0, 100.0, 0.05, 0.0, 0.2, OptionType::Call) - 1.0).abs() < f64::EPSILON);
        assert!((delta(90.0, 100.0, 0.05, 0.0, 0.2, OptionType::Call)).abs() < f64::EPSILON);
        assert!(
            (delta(90.0, 100.0, 0.05, 0.0, 0.2, OptionType::Put) - (-1.0)).abs() < f64::EPSILON
        );
        assert!((gamma(100.0, 100.0, 0.05, 0.0, 0.2)).abs() < f64::EPSILON);
        assert!((vega(100.0, 100.0, 0.05, 0.0, 0.2)).abs() < f64::EPSILON);
    }

    #[test]
    fn implied_vol_round_trips() {
        let cases = [
            (100.0_f64, 100.0_f64, 0.05_f64, 0.25_f64, 0.20_f64),
            (100.0, 110.0, 0.05, 0.50, 0.30),
            (100.0, 90.0, 0.05, 0.25, 0.15),
        ];
        for (s, k, r, t, v_true) in cases {
            let price = call(s, k, r, t, v_true);
            let v_solved = implied_vol(s, k, r, t, price, OptionType::Call)
                .expect("inside bracket — solver must succeed");
            // Bisection convergence is to 1e-6 in price space; resulting
            // vol-space error is typically a few ULP times that.
            assert!(
                (v_solved - v_true).abs() < 1e-5,
                "iv round-trip failed: S={s} K={k} v_true={v_true} v_solved={v_solved}",
            );
        }
    }

    #[test]
    fn implied_vol_rejects_outside_bracket() {
        // Below intrinsic → None.
        assert!(implied_vol(110.0, 100.0, 0.05, 0.25, 0.5, OptionType::Call).is_none());
        // Above max price → None.
        assert!(implied_vol(100.0, 100.0, 0.05, 0.25, 200.0, OptionType::Call).is_none());
        // T<=0 → None.
        assert!(implied_vol(100.0, 100.0, 0.05, 0.0, 5.0, OptionType::Call).is_none());
    }
}
