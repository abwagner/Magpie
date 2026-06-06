//! Implied-volatility bisection solver.
//!
//! Shared between [`crate::bs`] and [`crate::black76`]. Bug-for-bug
//! equivalent to `impliedVolBisection` in `src/lib/bs.js:77-90`:
//! same bracket (0.001..5.0), same tolerance (1e-6), same iteration cap
//! (100), same null-return guards (price ≤ intrinsic+tol or price ≥
//! maximum value).

/// Inclusive lower bracket on volatility. Matches the JS `lo = 0.001`.
pub const IV_LO: f64 = 0.001;
/// Inclusive upper bracket on volatility. Matches the JS `hi = 5.0`.
pub const IV_HI: f64 = 5.0;
/// Absolute price tolerance for convergence + the "below intrinsic"
/// margin. Matches the JS default `tol = 1e-6`.
pub const IV_TOL: f64 = 1e-6;
/// Iteration cap. Matches the JS default `maxIter = 100`.
pub const IV_MAX_ITER: usize = 100;

/// Bisect on `price_fn(v)` to find the volatility `v` such that the
/// modeled price matches `market_price`. Returns `None` when the
/// market price sits outside the no-arbitrage bracket
/// `(intrinsic, max_price)` (same guards as the JS reference).
///
/// On non-convergence after [`IV_MAX_ITER`] iterations, returns the
/// final mid-point — exactly what the JS does (`return (lo + hi) / 2`).
#[must_use]
pub fn bisection<F: Fn(f64) -> f64>(
    price_fn: F,
    market_price: f64,
    intrinsic: f64,
    max_price: f64,
) -> Option<f64> {
    if market_price <= intrinsic + IV_TOL || market_price <= 0.0 {
        return None;
    }
    if market_price >= max_price {
        return None;
    }
    let mut lo = IV_LO;
    let mut hi = IV_HI;
    for _ in 0..IV_MAX_ITER {
        let mid = f64::midpoint(lo, hi);
        let price = price_fn(mid);
        if (price - market_price).abs() < IV_TOL {
            return Some(mid);
        }
        if price < market_price {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some(f64::midpoint(lo, hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_none_below_intrinsic() {
        // Price function is irrelevant — the guard fires before any call.
        assert!(bisection(|_| 0.0, 0.5, 1.0, 100.0).is_none());
    }

    #[test]
    fn returns_none_at_or_above_max_price() {
        assert!(bisection(|_| 0.0, 100.0, 0.0, 100.0).is_none());
        assert!(bisection(|_| 0.0, 101.0, 0.0, 100.0).is_none());
    }

    #[test]
    fn returns_none_for_non_positive_market_price() {
        assert!(bisection(|_| 0.0, 0.0, -1.0, 100.0).is_none());
        assert!(bisection(|_| 0.0, -0.5, -1.0, 100.0).is_none());
    }

    #[test]
    fn finds_root_for_monotone_increasing_price_fn() {
        // Toy price = v * 10, monotone in v. Market = 2.0 → v = 0.2.
        let v = bisection(|v| v * 10.0, 2.0, 0.0, 50.0).expect("should solve");
        assert!((v - 0.2).abs() < 1e-5, "got v={v}");
    }
}
