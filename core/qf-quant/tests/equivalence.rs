//! Cross-language equivalence harness for `qf-quant`.
//!
//! Loads every JSON fixture under `tests/fixtures/equivalence_v1/`, dispatches
//! each case to the corresponding Rust function, and asserts agreement with
//! the JS reference at the case's declared tolerance (default 1e-9 — see
//! [`generate.mjs`](fixtures/equivalence_v1/generate.mjs)).
//!
//! [`expected_divergence.toml`](fixtures/equivalence_v1/expected_divergence.toml)
//! supplies per-case tolerance overrides — empty in Phase 1, populated by the
//! Phase 1.5 CDF cutover so that intentional bias is allowed and accidental
//! drift still fails the test.
//!
//! Backbone for Phase 1.5 ([`docs/polyglot-migration-tdd.md`] §8.1.1.1).
//!
//! [`docs/polyglot-migration-tdd.md`]: ../../../../docs/polyglot-migration-tdd.md

use qf_quant::bs::OptionType;
use qf_quant::{black76, bs, futures_specs, normal};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use toml::Value as TomlValue;

const FIXTURE_DIR: &str = "tests/fixtures/equivalence_v1";
const EXPECTED_DIVERGENCE_FILE: &str = "expected_divergence.toml";

#[derive(Deserialize)]
struct Fixture {
    schema_version: u32,
    function: String,
    #[serde(rename = "input_columns")]
    _input_columns: Vec<String>,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    inputs: serde_json::Value,
    expected: serde_json::Value,
    tolerance: f64,
}

fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(FIXTURE_DIR)
        .join(name)
}

fn load_fixture(name: &str) -> Fixture {
    let path = fixture_path(name);
    let body = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("failed to read {}: {e}", path.display());
    });
    let fix: Fixture = serde_json::from_str(&body).unwrap_or_else(|e| {
        panic!("failed to parse {}: {e}", path.display());
    });
    assert_eq!(
        fix.schema_version,
        1,
        "{} has schema_version={}, harness only knows v1",
        path.display(),
        fix.schema_version,
    );
    fix
}

/// Parsed expected-divergence config.
///
/// Two lookup modes:
///
/// - `per_case`: a specific case ID maps to a specific tolerance.
/// - `per_function`: a function name (matches the fixture's `function`
///   field) maps to a tolerance applied to every case under that
///   function. The Phase 1.5 cutover uses this form so we don't carry
///   a 5,000-row TOML.
///
/// Per-case wins over per-function when both are present. Duplicate
/// IDs across sections in the same mode are an error.
struct ExpectedDivergence {
    per_case: HashMap<String, f64>,
    per_function: HashMap<String, f64>,
}

impl ExpectedDivergence {
    fn tolerance_for(&self, function: &str, case_id: &str) -> Option<f64> {
        self.per_case
            .get(case_id)
            .copied()
            .or_else(|| self.per_function.get(function).copied())
    }
}

const PER_FUNCTION_SUFFIX: &str = "-functions";

fn parse_tolerance(value: &TomlValue, location: &str) -> f64 {
    match value {
        TomlValue::Float(f) => *f,
        TomlValue::Integer(i) => {
            #[allow(clippy::cast_precision_loss)]
            let f = *i as f64;
            f
        }
        other => panic!("{location}: tolerance must be a number, got {other:?}"),
    }
}

/// Parse `expected_divergence.toml`. Section names ending in `.functions`
/// (e.g. `[cdf-correction.functions]`) are per-function entries; other
/// sections are per-case. Empty Phase 1 file produces an empty config.
fn load_expected_divergence() -> ExpectedDivergence {
    let path = fixture_path(EXPECTED_DIVERGENCE_FILE);
    let body = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("failed to read {}: {e}", path.display());
    });
    let doc: BTreeMap<String, BTreeMap<String, TomlValue>> =
        toml::from_str(&body).unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()));

    let mut per_case: HashMap<String, f64> = HashMap::new();
    let mut per_function: HashMap<String, f64> = HashMap::new();
    for (section_name, section) in &doc {
        let is_per_function = section_name.ends_with(PER_FUNCTION_SUFFIX);
        let target = if is_per_function {
            &mut per_function
        } else {
            &mut per_case
        };
        for (id, val) in section {
            if id == "description" {
                continue;
            }
            let tol = parse_tolerance(val, &format!("{section_name}.{id}"));
            if let Some(prev) = target.insert(id.clone(), tol) {
                panic!(
                    "{id} appears in multiple expected_divergence \
                     {} sections (previous tolerance {prev})",
                    if is_per_function {
                        "per-function"
                    } else {
                        "per-case"
                    },
                );
            }
        }
    }
    ExpectedDivergence {
        per_case,
        per_function,
    }
}

fn as_f64_array<const N: usize>(v: &serde_json::Value, case_id: &str) -> [f64; N] {
    let arr = v.as_array().unwrap_or_else(|| {
        panic!("{case_id}: inputs must be a JSON array");
    });
    assert_eq!(
        arr.len(),
        N,
        "{case_id}: expected {N} inputs, got {}",
        arr.len()
    );
    let mut out = [0.0_f64; N];
    for (i, item) in arr.iter().enumerate() {
        out[i] = item.as_f64().unwrap_or_else(|| {
            panic!("{case_id}: input[{i}] is not a number: {item}");
        });
    }
    out
}

fn as_f64(v: &serde_json::Value, case_id: &str) -> f64 {
    v.as_f64().unwrap_or_else(|| {
        panic!("{case_id}: expected must be a number, got {v}");
    })
}

fn as_str<'a>(v: &'a serde_json::Value, case_id: &str) -> &'a str {
    v.as_str().unwrap_or_else(|| {
        panic!("{case_id}: expected must be a string, got {v}");
    })
}

/// Compute the Rust value for `function_name` on the case inputs.
/// Returns `Err(reason)` if the function isn't recognized.
///
/// Per-function arms here mirror the fixtures shipped under
/// `tests/fixtures/equivalence_v1/`. QF-140 removed the `normal::cdf`
/// arm (and its `normal_cdf.json` fixture) when the deprecated bug-for-bug
/// `cdf` function was retired in Phase 6.
#[allow(clippy::too_many_lines)]
fn evaluate_scalar(function_name: &str, case: &Case) -> Result<f64, String> {
    match function_name {
        "normal::pdf" => {
            let [x] = as_f64_array(&case.inputs, &case.id);
            Ok(normal::pdf(x))
        }
        // BS scalar functions: inputs = [S, K, r, T, v]
        "bs::call" => {
            let [s, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(bs::call(s, k, r, t, v))
        }
        "bs::put" => {
            let [s, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(bs::put(s, k, r, t, v))
        }
        "bs::delta_call" => {
            let [s, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(bs::delta(s, k, r, t, v, OptionType::Call))
        }
        "bs::delta_put" => {
            let [s, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(bs::delta(s, k, r, t, v, OptionType::Put))
        }
        "bs::gamma" => {
            let [s, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(bs::gamma(s, k, r, t, v))
        }
        "bs::theta_call" => {
            let [s, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(bs::theta(s, k, r, t, v, OptionType::Call))
        }
        "bs::theta_put" => {
            let [s, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(bs::theta(s, k, r, t, v, OptionType::Put))
        }
        "bs::vega" => {
            let [s, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(bs::vega(s, k, r, t, v))
        }
        // IV: inputs = [S, K, r, T, market_price]
        "bs::implied_vol_call" => {
            let [s, k, r, t, mp] = as_f64_array(&case.inputs, &case.id);
            bs::implied_vol(s, k, r, t, mp, OptionType::Call)
                .ok_or_else(|| format!("{}: implied_vol returned None", case.id))
        }
        "bs::implied_vol_put" => {
            let [s, k, r, t, mp] = as_f64_array(&case.inputs, &case.id);
            bs::implied_vol(s, k, r, t, mp, OptionType::Put)
                .ok_or_else(|| format!("{}: implied_vol returned None", case.id))
        }
        // Black-76 scalar functions
        "black76::call" => {
            let [f, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(black76::call(f, k, r, t, v))
        }
        "black76::put" => {
            let [f, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(black76::put(f, k, r, t, v))
        }
        "black76::delta_call" => {
            let [f, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(black76::delta(f, k, r, t, v, OptionType::Call))
        }
        "black76::delta_put" => {
            let [f, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(black76::delta(f, k, r, t, v, OptionType::Put))
        }
        "black76::gamma" => {
            let [f, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(black76::gamma(f, k, r, t, v))
        }
        "black76::theta_call" => {
            let [f, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(black76::theta(f, k, r, t, v, OptionType::Call))
        }
        "black76::theta_put" => {
            let [f, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(black76::theta(f, k, r, t, v, OptionType::Put))
        }
        "black76::vega" => {
            let [f, k, r, t, v] = as_f64_array(&case.inputs, &case.id);
            Ok(black76::vega(f, k, r, t, v))
        }
        "black76::implied_vol_call" => {
            let [f, k, r, t, mp] = as_f64_array(&case.inputs, &case.id);
            black76::implied_vol(f, k, r, t, mp, OptionType::Call)
                .ok_or_else(|| format!("{}: implied_vol returned None", case.id))
        }
        "black76::implied_vol_put" => {
            let [f, k, r, t, mp] = as_f64_array(&case.inputs, &case.id);
            black76::implied_vol(f, k, r, t, mp, OptionType::Put)
                .ok_or_else(|| format!("{}: implied_vol returned None", case.id))
        }
        other => Err(format!("unknown scalar function: {other}")),
    }
}

fn check_scalar_fixture(fixture_name: &str, divergence: &ExpectedDivergence) {
    let fix = load_fixture(fixture_name);
    let mut mismatches: Vec<String> = Vec::new();
    for case in &fix.cases {
        let want = as_f64(&case.expected, &case.id);
        let got = match evaluate_scalar(&fix.function, case) {
            Ok(v) => v,
            Err(reason) => {
                mismatches.push(reason);
                continue;
            }
        };
        let tol = divergence
            .tolerance_for(&fix.function, &case.id)
            .unwrap_or(case.tolerance);
        if tol == 0.0 {
            // Any finite value passes — divergence section explicitly allowed.
            if !got.is_finite() {
                mismatches.push(format!(
                    "{}: non-finite Rust output {got} (expected {want})",
                    case.id
                ));
            }
            continue;
        }
        let diff = (got - want).abs();
        if diff > tol {
            mismatches.push(format!(
                "{}: |Rust {got} − JS {want}| = {diff:.3e} > tol {tol:.0e}",
                case.id,
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "\n{} mismatches in {fixture_name}:\n  {}",
        mismatches.len(),
        mismatches
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n  "),
    );
}

fn check_string_fixture(fixture_name: &str, evaluator: impl Fn(&str) -> String) {
    let fix = load_fixture(fixture_name);
    let mut mismatches: Vec<String> = Vec::new();
    for case in &fix.cases {
        let inputs = case.inputs.as_array().unwrap_or_else(|| {
            panic!("{}: inputs must be array", case.id);
        });
        let input = as_str(&inputs[0], &case.id);
        let want = as_str(&case.expected, &case.id);
        let got = evaluator(input);
        if got != want {
            mismatches.push(format!(
                "{}: input={input:?} Rust={got:?} JS={want:?}",
                case.id
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "\n{} mismatches in {fixture_name}:\n  {}",
        mismatches.len(),
        mismatches
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n  "),
    );
}

#[test]
fn equivalence_v1_full_sweep() {
    let divergence = load_expected_divergence();

    let scalar_fixtures = [
        "normal_pdf.json",
        "bs_call.json",
        "bs_put.json",
        "bs_delta_call.json",
        "bs_delta_put.json",
        "bs_gamma.json",
        "bs_theta_call.json",
        "bs_theta_put.json",
        "bs_vega.json",
        "bs_iv_call.json",
        "bs_iv_put.json",
        "black76_call.json",
        "black76_put.json",
        "black76_delta_call.json",
        "black76_delta_put.json",
        "black76_gamma.json",
        "black76_theta_call.json",
        "black76_theta_put.json",
        "black76_vega.json",
        "black76_iv_call.json",
        "black76_iv_put.json",
    ];
    for name in scalar_fixtures {
        check_scalar_fixture(name, &divergence);
    }

    // String fixture — futures_specs::futures_root
    check_string_fixture("futures_root.json", |s| {
        futures_specs::futures_root(s).to_string()
    });
}

#[test]
fn expected_divergence_uses_only_known_references() {
    // Safety net: every entry in expected_divergence.toml must either
    // match a real fixture case ID (per-case section) or a real
    // function name (per-function section). Stops stale entries from
    // rotting silently when fixtures change.
    let divergence = load_expected_divergence();
    if divergence.per_case.is_empty() && divergence.per_function.is_empty() {
        return;
    }
    let fixtures = [
        "normal_pdf.json",
        "bs_call.json",
        "bs_put.json",
        "bs_delta_call.json",
        "bs_delta_put.json",
        "bs_gamma.json",
        "bs_theta_call.json",
        "bs_theta_put.json",
        "bs_vega.json",
        "bs_iv_call.json",
        "bs_iv_put.json",
        "black76_call.json",
        "black76_put.json",
        "black76_delta_call.json",
        "black76_delta_put.json",
        "black76_gamma.json",
        "black76_theta_call.json",
        "black76_theta_put.json",
        "black76_vega.json",
        "black76_iv_call.json",
        "black76_iv_put.json",
        "futures_root.json",
    ];
    let mut all_case_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut all_fn_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in fixtures {
        let fix = load_fixture(name);
        all_fn_names.insert(fix.function);
        for case in fix.cases {
            all_case_ids.insert(case.id);
        }
    }
    let unknown_cases: Vec<&String> = divergence
        .per_case
        .keys()
        .filter(|k| !all_case_ids.contains(*k))
        .collect();
    let unknown_fns: Vec<&String> = divergence
        .per_function
        .keys()
        .filter(|k| !all_fn_names.contains(*k))
        .collect();
    assert!(
        unknown_cases.is_empty() && unknown_fns.is_empty(),
        "expected_divergence.toml references unknown entries:\n  \
         per-case: {unknown_cases:?}\n  per-function: {unknown_fns:?}",
    );
}
