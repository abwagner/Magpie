//! Black-76 for options on futures.
//!
//! Ports the `Black76` object in `src/lib/bs.js:22-72` to Rust. After
//! the Phase 1.5 CDF cutover, every CDF reference goes through
//! [`crate::normal::cdf_correct`]; the legacy [`crate::normal::cdf`]
//! stays available as `#[deprecated]` for external callers until
//! Phase 6.
//!
//! Unlike Black-Scholes, the underlying here is a futures price `F`
//! rather than a spot `S`. The forward `F` already absorbs cost-of-
//! carry, so the discount factor `exp(-rT)` appears symmetrically on
//! call and put, and parity is `C - P = exp(-rT)·(F - K)`.

use crate::bs::OptionType;
use crate::iv::bisection;
use crate::normal::{cdf_correct as cdf, pdf};

#[inline]
fn d1(f: f64, k: f64, t: f64, v: f64) -> f64 {
    ((f / k).ln() + (v * v / 2.0) * t) / (v * t.sqrt())
}

#[inline]
fn d2(f: f64, k: f64, t: f64, v: f64) -> f64 {
    d1(f, k, t, v) - v * t.sqrt()
}

/// Black-76 call price.
#[must_use]
pub fn call(f: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    if t <= 0.0 {
        return (f - k).max(0.0);
    }
    let disc = (-r * t).exp();
    disc * (f * cdf(d1(f, k, t, v)) - k * cdf(d2(f, k, t, v)))
}

/// Black-76 put price.
#[must_use]
pub fn put(f: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    if t <= 0.0 {
        return (k - f).max(0.0);
    }
    let disc = (-r * t).exp();
    disc * (k * cdf(-d2(f, k, t, v)) - f * cdf(-d1(f, k, t, v)))
}

/// Δ. At expiry, returns the digital indicator (1/0 for in-/out-of-the-money
/// call; -1/0 for put), matching the JS `T<=0` branch.
#[must_use]
pub fn delta(f: f64, k: f64, r: f64, t: f64, v: f64, kind: OptionType) -> f64 {
    if t <= 0.0 {
        return match kind {
            OptionType::Call => f64::from(f > k),
            OptionType::Put => -f64::from(f < k),
        };
    }
    let disc = (-r * t).exp();
    let nd1 = cdf(d1(f, k, t, v));
    match kind {
        OptionType::Call => disc * nd1,
        OptionType::Put => disc * (nd1 - 1.0),
    }
}

/// Γ. Symmetric in call/put.
#[must_use]
pub fn gamma(f: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    (-r * t).exp() * pdf(d1(f, k, t, v)) / (f * v * t.sqrt())
}

/// Θ per calendar day. Annualized model output divided by 365.
#[must_use]
pub fn theta(f: f64, k: f64, r: f64, t: f64, v: f64, kind: OptionType) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    let big_d1 = d1(f, k, t, v);
    let big_d2 = d2(f, k, t, v);
    let disc = (-r * t).exp();
    let common = -f * disc * pdf(big_d1) * v / (2.0 * t.sqrt());
    let annual = match kind {
        OptionType::Call => common + r * f * disc * cdf(big_d1) - r * k * disc * cdf(big_d2),
        OptionType::Put => common - r * f * disc * cdf(-big_d1) + r * k * disc * cdf(-big_d2),
    };
    annual / 365.0
}

/// Vega per 1% vol point. Annualized model output divided by 100.
#[must_use]
pub fn vega(f: f64, k: f64, r: f64, t: f64, v: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    f * (-r * t).exp() * t.sqrt() * pdf(d1(f, k, t, v)) / 100.0
}

/// Implied volatility via [`crate::iv::bisection`]. Returns `None` when
/// the market price sits outside the no-arbitrage bracket
/// `(intrinsic, max_price)`, matching the JS guards.
#[must_use]
pub fn implied_vol(
    f: f64,
    k: f64,
    r: f64,
    t: f64,
    market_price: f64,
    kind: OptionType,
) -> Option<f64> {
    if t <= 0.0 {
        return None;
    }
    let disc = (-r * t).exp();
    let intrinsic = match kind {
        OptionType::Call => (disc * (f - k)).max(0.0),
        OptionType::Put => (disc * (k - f)).max(0.0),
    };
    let max_price = match kind {
        OptionType::Call => disc * f,
        OptionType::Put => disc * k,
    };
    let price_fn = |v: f64| match kind {
        OptionType::Call => call(f, k, r, t, v),
        OptionType::Put => put(f, k, r, t, v),
    };
    bisection(price_fn, market_price, intrinsic, max_price)
}

#[cfg(test)]
mod tests {
    use super::*;

    // See bs.rs SCIPY_PARITY_TOL for the rationale; same A&S 7.1.26
    // error budget propagates to Black-76.
    const SCIPY_PARITY_TOL: f64 = 5e-5;

    // Reference values computed against scipy.stats.norm.cdf for the
    // textbook Black-76 formulas. Post-Phase-1.5 cutover anchor.
    // Tuple: (F, K, r, T, v, call, put, delta_c, delta_p, gamma,
    //         theta_c, theta_p, vega).
    const B76_TEXTBOOK_REF: &[(
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
            3.938_224_402_866_887,
            3.938_224_402_866_887,
            0.513_480_022_261_275_2,
            -0.474_097_778_232_606_24,
            0.039_349_436_430_188_01,
            -0.021_021_852_235_326_734,
            -0.021_021_852_235_326_734,
            0.196_747_182_150_940_06,
        ),
        (
            100.0,
            100.0,
            0.05,
            1.0,
            0.2,
            7.577_082_146_427_28,
            7.577_082_146_427_28,
            0.513_500_122_982_493_4,
            -0.437_729_301_518_220_65,
            0.018_879_647_164_532_515,
            -0.009_307_055_686_534_628,
            -0.009_307_055_686_534_63,
            0.377_592_943_290_650_3,
        ),
        (
            110.0,
            100.0,
            0.05,
            0.25,
            0.2,
            10.817_875_271_976_035,
            0.942_097_267_037_231_5,
            0.831_633_465_131_073,
            -0.155_944_335_362_808_44,
            0.021_656_699_761_023_15,
            -0.012_876_787_886_489_865,
            -0.014_229_634_188_536_277,
            0.131_023_033_554_190_04,
        ),
        (
            90.0,
            100.0,
            0.05,
            0.25,
            0.2,
            0.703_531_558_458_291_9,
            10.579_309_563_397_109,
            0.155_824_453_704_418_64,
            -0.831_753_346_789_462_8,
            0.026_455_934_854_998_135,
            -0.011_645_711_968_730_914,
            -0.010_292_865_666_684_504,
            0.107_146_536_162_742_46,
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
            9.824_073_335_638_61,
            9.824_073_335_638_61,
            0.542_909_266_925_133_7,
            -0.444_668_533_568_747_64,
            0.015_636_820_489_019_255,
            -0.052_204_991_628_745_58,
            -0.052_204_991_628_745_58,
            0.195_460_256_112_740_68,
        ),
        (
            100.0,
            100.0,
            0.05,
            0.25,
            0.05,
            0.984_940_699_942_968_6,
            0.984_940_699_942_968_6,
            0.498_713_603_746_655_5,
            -0.488_864_196_747_225_9,
            0.157_582_304_322_703_31,
            -0.005_261_730_874_072_995,
            -0.005_261_730_874_072_994,
            0.196_977_880_403_379_16,
        ),
        (
            100.0,
            100.0,
            0.05,
            0.01,
            0.2,
            0.797_472_427_012_145_8,
            0.797_472_427_012_145_8,
            0.503_737_424_624_645_3,
            -0.495_762_700_354_523_9,
            0.199_361_461_238_085_5,
            -0.109_129_914_044_565_73,
            -0.109_129_914_044_565_73,
            0.039_872_292_247_617_104,
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
    fn b76_matches_textbook_at_grid() {
        for &(
            f,
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
        ) in B76_TEXTBOOK_REF
        {
            let inputs = (f, k, r, t, v);
            assert_close(call(f, k, r, t, v), call_ref, "call", inputs);
            assert_close(put(f, k, r, t, v), put_ref, "put", inputs);
            assert_close(
                delta(f, k, r, t, v, OptionType::Call),
                delta_c_ref,
                "delta_call",
                inputs,
            );
            assert_close(
                delta(f, k, r, t, v, OptionType::Put),
                delta_p_ref,
                "delta_put",
                inputs,
            );
            assert_close(gamma(f, k, r, t, v), gamma_ref, "gamma", inputs);
            assert_close(
                theta(f, k, r, t, v, OptionType::Call),
                theta_c_ref,
                "theta_call",
                inputs,
            );
            assert_close(
                theta(f, k, r, t, v, OptionType::Put),
                theta_p_ref,
                "theta_put",
                inputs,
            );
            assert_close(vega(f, k, r, t, v), vega_ref, "vega", inputs);
        }
    }

    #[test]
    fn black76_parity() {
        // C - P = exp(-rT) · (F - K). Holds bug-for-bug because both
        // sides use the same buggy CDF.
        for &(f, k, r, t, v, ..) in B76_TEXTBOOK_REF {
            let lhs = call(f, k, r, t, v) - put(f, k, r, t, v);
            let rhs = (-r * t).exp() * (f - k);
            assert!(
                (lhs - rhs).abs() < 1e-10,
                "parity violated at F={f} K={k} r={r} T={t} v={v}: {lhs} vs {rhs}",
            );
        }
    }

    #[test]
    fn at_expiry_returns_intrinsic() {
        assert!((call(110.0, 100.0, 0.05, 0.0, 0.2) - 10.0).abs() < f64::EPSILON);
        assert!((put(90.0, 100.0, 0.05, 0.0, 0.2) - 10.0).abs() < f64::EPSILON);
        assert!((call(90.0, 100.0, 0.05, 0.0, 0.2)).abs() < f64::EPSILON);
        assert!((put(110.0, 100.0, 0.05, 0.0, 0.2)).abs() < f64::EPSILON);
    }

    #[test]
    fn implied_vol_round_trips() {
        let cases = [
            (100.0_f64, 100.0_f64, 0.05_f64, 0.25_f64, 0.20_f64),
            (100.0, 110.0, 0.05, 0.50, 0.30),
            (100.0, 90.0, 0.05, 0.25, 0.15),
        ];
        for (f, k, r, t, v_true) in cases {
            let price = call(f, k, r, t, v_true);
            let v_solved = implied_vol(f, k, r, t, price, OptionType::Call)
                .expect("inside bracket — solver must succeed");
            assert!(
                (v_solved - v_true).abs() < 1e-5,
                "iv round-trip failed: F={f} K={k} v_true={v_true} v_solved={v_solved}",
            );
        }
    }

    #[test]
    fn implied_vol_rejects_outside_bracket() {
        assert!(implied_vol(110.0, 100.0, 0.05, 0.25, 0.001, OptionType::Call).is_none());
        assert!(implied_vol(100.0, 100.0, 0.05, 0.25, 200.0, OptionType::Call).is_none());
        assert!(implied_vol(100.0, 100.0, 0.05, 0.0, 5.0, OptionType::Call).is_none());
    }
}
