//! Risk-neutral probability tooling: Breeden-Litzenberger extraction,
//! log-normal reference PDF, blending, and edge computation.
//!
//! Ports `src/lib/probability.js` to Rust.
//!
//! The Breeden-Litzenberger formula
//!
//! `q(K) = exp(rT) · ∂²C/∂K²`
//!
//! recovers the risk-neutral density at strike `K` from a call-price
//! function. We approximate the second derivative with the centered
//! 3-point finite difference (matching the JS reference):
//!
//! `q(K) ≈ exp(rT) · (C(K-δ) − 2·C(K) + C(K+δ)) / δ²`
//!
//! All densities are clipped to non-negative and normalized to a unit
//! integral over the chosen strike grid.

/// Result of a PDF extraction or blend. The strike grid is shared across
/// `density` and `cdf` (same index → same strike). Summary stats are
/// computed against `density` over the strike grid.
#[derive(Clone, Debug)]
pub struct PdfResult {
    pub strikes: Vec<f64>,
    pub density: Vec<f64>,
    pub cdf: Vec<f64>,
    pub dte: f64,
    pub spot: f64,
    pub strike_step: f64,
    pub expected_value: f64,
    pub variance: f64,
}

/// Knobs for [`breeden_litzenberger_pdf`]. Defaults match the JS:
/// `strikeStep = 0.5`, `rangeMultiple = 0.5`.
#[derive(Copy, Clone, Debug)]
pub struct ExtractOptions {
    /// Finite-difference step `δ`. Smaller → more strikes, higher noise.
    pub strike_step: f64,
    /// How far above/below spot to extend the grid, as a fraction.
    /// `0.5` means `[spot·0.5, spot·1.5]`.
    pub range_multiple: f64,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            strike_step: 0.5,
            range_multiple: 0.5,
        }
    }
}

/// Extract the risk-neutral PDF from a call-price function via
/// Breeden-Litzenberger. The closure `call_price` is called repeatedly
/// at `K-δ`, `K`, `K+δ` for `K` stepping across the configured range.
///
/// Densities are clipped to non-negative and normalized to unit area.
/// CDF saturates at 1.0 (matches JS `Math.min(cumulative, 1)`).
#[must_use]
pub fn breeden_litzenberger_pdf<F: Fn(f64) -> f64>(
    call_price: F,
    spot: f64,
    rfr: f64,
    dte: f64,
    opts: ExtractOptions,
) -> PdfResult {
    let t = (dte / 365.0).max(1.0 / 365.0);
    let discount = (rfr * t).exp();
    let delta = opts.strike_step;

    let lo_strike = (spot * (1.0 - opts.range_multiple)).floor();
    let hi_strike = (spot * (1.0 + opts.range_multiple)).ceil();

    let mut strikes = Vec::new();
    let mut density = Vec::new();

    // Match the JS loop: K starts at lo + δ, ends ≤ hi - δ, steps by δ.
    // Generate the count up front so float-step drift can't drop the
    // last sample.
    let usable = (hi_strike - lo_strike - 2.0 * delta) / delta;
    let count: u32 = if usable >= 0.0 {
        // The strike grid is bounded by `spot * (1 ± range_multiple)` and
        // stepped by `delta`, so the count is always within tens of
        // thousands at most — well below u32::MAX. The `>= 0.0` guard
        // covers the sign-loss case clippy can't see through.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let n = usable.floor() as u32 + 1;
        n
    } else {
        0
    };
    for i in 0..count {
        let k = lo_strike + delta + f64::from(i) * delta;
        let c_minus = call_price(k - delta);
        let c_center = call_price(k);
        let c_plus = call_price(k + delta);

        let q = discount * (c_minus - 2.0 * c_center + c_plus) / (delta * delta);
        strikes.push(k);
        density.push(q.max(0.0));
    }

    normalize_in_place(&mut density, delta);
    let cdf = cumulative_cdf(&density, delta);

    let (expected_value, variance) = mean_and_variance(&strikes, &density, delta);

    PdfResult {
        strikes,
        density,
        cdf,
        dte,
        spot,
        strike_step: delta,
        expected_value,
        variance,
    }
}

/// Log-normal reference PDF — the Black-Scholes-implied density of the
/// underlying at expiry. Returns a flat density vector aligned with
/// `strikes`, normalized to unit area over that strike grid.
///
/// `t` is in years, `sigma` is annualized vol.
#[must_use]
pub fn log_normal_pdf(spot: f64, rfr: f64, t: f64, sigma: f64, strikes: &[f64]) -> Vec<f64> {
    let two_pi_t = std::f64::consts::TAU * t;
    let mut density: Vec<f64> = strikes
        .iter()
        .map(|&k| {
            if k <= 0.0 {
                return 0.0;
            }
            let d = ((k / spot).ln() - (rfr - sigma * sigma / 2.0) * t) / (sigma * t.sqrt());
            (-d * d / 2.0).exp() / (k * sigma * two_pi_t.sqrt())
        })
        .collect();

    let step = if strikes.len() > 1 {
        strikes[1] - strikes[0]
    } else {
        1.0
    };
    normalize_in_place(&mut density, step);
    density
}

/// Blend multiple PDFs on the first model's strike grid using `weights`
/// (which are renormalized to sum to 1). Returns `None` when `models`
/// is empty; returns a clone of the only model when `models.len() == 1`.
///
/// Each blended-strike value comes from the closest-strike entry in
/// each input model (matches JS `findClosestIndex` + `interpolatePDF`).
#[must_use]
pub fn blend_pdfs(models: &[&PdfResult], weights: &[f64]) -> Option<PdfResult> {
    if models.is_empty() {
        return None;
    }
    if models.len() == 1 {
        return Some(models[0].clone());
    }
    let total_w: f64 = weights.iter().sum();
    let norm: Vec<f64> = weights.iter().map(|w| w / total_w).collect();

    let strikes = models[0].strikes.clone();
    let step = if strikes.len() > 1 {
        strikes[1] - strikes[0]
    } else {
        1.0
    };

    let mut blended = vec![0.0_f64; strikes.len()];
    for (m_idx, model) in models.iter().enumerate() {
        let w = norm[m_idx];
        for (i, &k) in strikes.iter().enumerate() {
            let v = if model.strikes.is_empty() {
                0.0
            } else {
                let idx = find_closest_index(&model.strikes, k);
                model.density.get(idx).copied().unwrap_or(0.0)
            };
            blended[i] += w * v;
        }
    }

    normalize_in_place(&mut blended, step);
    let cdf = cumulative_cdf(&blended, step);
    let (expected_value, variance) = mean_and_variance(&strikes, &blended, step);

    Some(PdfResult {
        strikes,
        density: blended,
        cdf,
        dte: models[0].dte,
        spot: models[0].spot,
        strike_step: step,
        expected_value,
        variance,
    })
}

/// Pointwise probability-density edge: `model − market` at each market
/// strike. Includes integrated summary stats (expected-price delta and
/// variance delta vs the market spot).
#[derive(Clone, Debug)]
pub struct EdgeResult {
    pub strikes: Vec<f64>,
    pub edge: Vec<f64>,
    pub dte: f64,
    pub spot: f64,
    pub expected_price_delta: f64,
    pub variance_delta: f64,
}

/// Compute `model − market` density per strike on the market's strike
/// grid. The model is interpolated nearest-neighbour onto the market grid.
#[must_use]
pub fn compute_edge(model: &PdfResult, market: &PdfResult) -> EdgeResult {
    let strikes = market.strikes.clone();
    let step = if strikes.len() > 1 {
        strikes[1] - strikes[0]
    } else {
        1.0
    };

    let edge: Vec<f64> = strikes
        .iter()
        .enumerate()
        .map(|(i, &k)| {
            let model_val = if model.strikes.is_empty() {
                0.0
            } else {
                let idx = find_closest_index(&model.strikes, k);
                model.density.get(idx).copied().unwrap_or(0.0)
            };
            let market_val = market.density.get(i).copied().unwrap_or(0.0);
            model_val - market_val
        })
        .collect();

    let expected_price_delta: f64 = strikes
        .iter()
        .zip(edge.iter())
        .map(|(&k, &e)| k * e * step)
        .sum();
    let spot = market.spot;
    let variance_delta: f64 = strikes
        .iter()
        .zip(edge.iter())
        .map(|(&k, &e)| (k - spot).powi(2) * e * step)
        .sum();

    EdgeResult {
        strikes,
        edge,
        dte: market.dte,
        spot,
        expected_price_delta,
        variance_delta,
    }
}

// ── internal helpers ────────────────────────────────────────────────

fn normalize_in_place(density: &mut [f64], step: f64) {
    let total: f64 = density.iter().sum::<f64>() * step;
    if total > 0.0 {
        for d in density.iter_mut() {
            *d /= total;
        }
    }
}

fn cumulative_cdf(density: &[f64], step: f64) -> Vec<f64> {
    let mut cdf = Vec::with_capacity(density.len());
    let mut cum = 0.0_f64;
    for &d in density {
        cum += d * step;
        cdf.push(cum.min(1.0));
    }
    cdf
}

fn mean_and_variance(strikes: &[f64], density: &[f64], step: f64) -> (f64, f64) {
    let mean: f64 = strikes
        .iter()
        .zip(density.iter())
        .map(|(&k, &d)| k * d * step)
        .sum();
    let var: f64 = strikes
        .iter()
        .zip(density.iter())
        .map(|(&k, &d)| (k - mean).powi(2) * d * step)
        .sum();
    (mean, var)
}

fn find_closest_index(arr: &[f64], target: f64) -> usize {
    // Binary search to first index where arr[i] >= target.
    let mut lo = 0_usize;
    let mut hi = arr.len().saturating_sub(1);
    while lo < hi {
        let mid = lo.midpoint(hi);
        if arr[mid] < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    // Snap to whichever neighbour is actually closer.
    if lo > 0 && (arr[lo - 1] - target).abs() < (arr[lo] - target).abs() {
        lo - 1
    } else {
        lo
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TS_PARITY_TOL: f64 = 1e-9;

    fn assert_close(got: f64, want: f64, ctx: &str) {
        let diff = (got - want).abs();
        assert!(
            diff < TS_PARITY_TOL,
            "{ctx}: got={got}, want={want}, |diff|={diff}",
        );
    }

    #[test]
    fn log_normal_pdf_matches_js() {
        // node -e 'import("./src/lib/probability.js").then(m =>
        //   console.log(m.logNormalPDF(100, 0.05, 0.5, 0.2, [90,95,100,105,110])))'
        let strikes = [90.0_f64, 95.0, 100.0, 105.0, 110.0];
        let got = log_normal_pdf(100.0, 0.05, 0.5, 0.2, &strikes);
        let want = [
            0.035_077_741_761_077_14,
            0.042_768_245_147_308_835,
            0.045_093_928_709_761_87,
            0.041_973_483_556_270_83,
            0.035_086_600_825_581_3,
        ];
        for (i, (g, w)) in got.iter().zip(want.iter()).enumerate() {
            assert_close(*g, *w, &format!("log_normal_pdf[{i}]"));
        }
    }

    #[test]
    fn log_normal_pdf_normalizes() {
        let strikes: Vec<f64> = (50..=150).map(f64::from).collect();
        let pdf = log_normal_pdf(100.0, 0.05, 0.5, 0.2, &strikes);
        let step = strikes[1] - strikes[0];
        let area: f64 = pdf.iter().sum::<f64>() * step;
        assert!((area - 1.0).abs() < 1e-9, "log-normal area = {area}");
    }

    #[test]
    fn log_normal_pdf_zero_strikes_safe() {
        // K=0 should yield density 0 (not NaN). Negative K too.
        let strikes = [0.0_f64, -5.0, 100.0];
        let pdf = log_normal_pdf(100.0, 0.05, 0.5, 0.2, &strikes);
        assert!(pdf[0].abs() < f64::EPSILON);
        assert!(pdf[1].abs() < f64::EPSILON);
        assert!(pdf[2] > 0.0);
    }

    #[test]
    fn bl_pdf_recovers_log_normal_from_bs_call_prices() {
        // When the call-price function is BS at flat sigma, BL extraction
        // should recover a density close to the BS log-normal density.
        // Use the bug-for-bug BS (since the crate's CDF is the buggy one
        // in Phase 1) — both sides share the same bias so the recovered
        // density still lies near the analytic log-normal shape.
        let spot = 100.0_f64;
        let rfr = 0.05;
        let sigma = 0.2;
        let dte = 30.0;
        let pdf = breeden_litzenberger_pdf(
            |k| crate::bs::call(spot, k, rfr, dte / 365.0, sigma),
            spot,
            rfr,
            dte,
            ExtractOptions {
                strike_step: 0.5,
                range_multiple: 0.2,
            },
        );

        // Match the JS-reported grid layout for this exact call:
        //   spot=100, dte=30, strikeStep=0.5, rangeMultiple=0.2
        //   → 79 strikes from 80.5 to 119.5
        assert_eq!(pdf.strikes.len(), 79);
        assert_close(pdf.strikes[0], 80.5, "first strike");
        assert_close(pdf.strikes[pdf.strikes.len() - 1], 119.5, "last strike");
        assert_close(pdf.strike_step, 0.5, "strike_step");

        // Density saturates to ~0 in the tails and is sharply peaked near
        // spot. Verify the peak sits in the right neighbourhood and the
        // distribution integrates to ~1.
        let area: f64 = pdf.density.iter().sum::<f64>() * pdf.strike_step;
        assert!((area - 1.0).abs() < 1e-9, "BL area = {area}");

        let peak_idx = pdf
            .density
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).expect("not NaN"))
            .map(|(i, _)| i)
            .expect("non-empty");
        let peak_strike = pdf.strikes[peak_idx];
        assert!(
            (peak_strike - 100.0).abs() <= 1.0,
            "BL peak {peak_strike} is not near spot 100",
        );

        // Last CDF should sit at ~1 (saturated).
        let last_cdf = pdf.cdf[pdf.cdf.len() - 1];
        assert!(
            (last_cdf - 1.0).abs() < 1e-9,
            "BL last_cdf = {last_cdf}, want ~1",
        );
    }

    fn pdf_from_density(strikes: Vec<f64>, density: Vec<f64>, spot: f64) -> PdfResult {
        let step = if strikes.len() > 1 {
            strikes[1] - strikes[0]
        } else {
            1.0
        };
        let mut cdf = Vec::with_capacity(density.len());
        let mut cum = 0.0_f64;
        for &d in &density {
            cum += d * step;
            cdf.push(cum.min(1.0));
        }
        PdfResult {
            strikes,
            density,
            cdf,
            dte: 30.0,
            spot,
            strike_step: step,
            expected_value: 0.0,
            variance: 0.0,
        }
    }

    #[test]
    fn blend_pdfs_renormalizes_and_blends() {
        // Two density vectors on the same grid (un-normalized — the JS
        // normalizes at the end). Equal weights.
        let p1 = pdf_from_density(
            vec![90.0, 95.0, 100.0, 105.0, 110.0],
            vec![0.1, 0.2, 0.4, 0.2, 0.1],
            100.0,
        );
        let p2 = pdf_from_density(
            vec![90.0, 95.0, 100.0, 105.0, 110.0],
            vec![0.2, 0.2, 0.2, 0.2, 0.2],
            100.0,
        );
        let blended = blend_pdfs(&[&p1, &p2], &[1.0, 1.0]).expect("two inputs blend");
        // Reference from JS: [0.030..., 0.04, 0.060..., 0.04, 0.030...]
        let want = [0.03_f64, 0.04, 0.06, 0.04, 0.03];
        for (i, (g, w)) in blended.density.iter().zip(want.iter()).enumerate() {
            assert_close(*g, *w, &format!("blend[{i}]"));
        }
    }

    #[test]
    fn blend_pdfs_handles_empty_and_single() {
        assert!(blend_pdfs(&[], &[]).is_none());
        let p = pdf_from_density(vec![100.0], vec![1.0], 100.0);
        let single = blend_pdfs(&[&p], &[1.0]).expect("single passes through");
        assert_eq!(single.density, p.density);
    }

    #[test]
    fn compute_edge_matches_js() {
        // Same fixture pair as blend test. Edge = model − market.
        let model = pdf_from_density(
            vec![90.0, 95.0, 100.0, 105.0, 110.0],
            vec![0.1, 0.2, 0.4, 0.2, 0.1],
            100.0,
        );
        let market = pdf_from_density(
            vec![90.0, 95.0, 100.0, 105.0, 110.0],
            vec![0.2, 0.2, 0.2, 0.2, 0.2],
            100.0,
        );
        let edge = compute_edge(&model, &market);
        let want_edge = [-0.1_f64, 0.0, 0.2, 0.0, -0.1];
        for (i, (g, w)) in edge.edge.iter().zip(want_edge.iter()).enumerate() {
            assert_close(*g, *w, &format!("edge[{i}]"));
        }
        assert_close(edge.expected_price_delta, 0.0, "ev_delta");
        assert_close(edge.variance_delta, -100.0, "var_delta");
    }
}
