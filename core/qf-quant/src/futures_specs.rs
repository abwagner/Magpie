//! Futures contract specifications.
//!
//! Ports `src/lib/futures-specs.js` to Rust. Holds the per-symbol
//! multiplier, tick size, tick value, unit, and exchange — what the
//! execution layer needs for position sizing and P&L scaling and what
//! the GUI needs for display formatting.
//!
//! The root-symbol parser matches the JS regex
//! `^([A-Z0-9]{1,3})[FGHJKMNQUVXZ]\d{1,2}$` after stripping any
//! leading `/` or `./`. When the input doesn't match, the function
//! returns the post-strip string unchanged — matching the JS fallback.

/// All fields are intentionally `&'static str` / `f64` — the spec
/// table is `const`, no heap allocation, and the entries are safe to
/// hand out as borrowed references.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct FuturesSpec {
    pub root: &'static str,
    pub name: &'static str,
    pub multiplier: f64,
    pub tick_size: f64,
    pub tick_value: f64,
    pub unit: &'static str,
    pub exchange: &'static str,
}

/// Authoritative table. Mirrors the JS `FUTURES_SPECS` object.
pub const FUTURES_SPECS: &[FuturesSpec] = &[
    FuturesSpec {
        root: "CL",
        name: "Crude Oil",
        multiplier: 1000.0,
        tick_size: 0.01,
        tick_value: 10.0,
        unit: "bbl",
        exchange: "NYMEX",
    },
    FuturesSpec {
        root: "ES",
        name: "E-mini S&P 500",
        multiplier: 50.0,
        tick_size: 0.25,
        tick_value: 12.5,
        unit: "idx",
        exchange: "CME",
    },
    FuturesSpec {
        root: "NQ",
        name: "E-mini Nasdaq 100",
        multiplier: 20.0,
        tick_size: 0.25,
        tick_value: 5.0,
        unit: "idx",
        exchange: "CME",
    },
    FuturesSpec {
        root: "YM",
        name: "E-mini Dow",
        multiplier: 5.0,
        tick_size: 1.0,
        tick_value: 5.0,
        unit: "idx",
        exchange: "CBOT",
    },
    FuturesSpec {
        root: "RTY",
        name: "E-mini Russell 2000",
        multiplier: 50.0,
        tick_size: 0.1,
        tick_value: 5.0,
        unit: "idx",
        exchange: "CME",
    },
    FuturesSpec {
        root: "GC",
        name: "Gold",
        multiplier: 100.0,
        tick_size: 0.1,
        tick_value: 10.0,
        unit: "oz",
        exchange: "COMEX",
    },
    FuturesSpec {
        root: "SI",
        name: "Silver",
        multiplier: 5000.0,
        tick_size: 0.005,
        tick_value: 25.0,
        unit: "oz",
        exchange: "COMEX",
    },
    FuturesSpec {
        root: "HG",
        name: "Copper",
        multiplier: 25000.0,
        tick_size: 0.0005,
        tick_value: 12.5,
        unit: "lb",
        exchange: "COMEX",
    },
    FuturesSpec {
        root: "NG",
        name: "Natural Gas",
        multiplier: 10000.0,
        tick_size: 0.001,
        tick_value: 10.0,
        unit: "mmBtu",
        exchange: "NYMEX",
    },
    FuturesSpec {
        root: "ZB",
        name: "30-Year T-Bond",
        multiplier: 1000.0,
        tick_size: 1.0 / 32.0,
        tick_value: 31.25,
        unit: "pts",
        exchange: "CBOT",
    },
    FuturesSpec {
        root: "ZN",
        name: "10-Year T-Note",
        multiplier: 1000.0,
        tick_size: 1.0 / 64.0,
        tick_value: 15.625,
        unit: "pts",
        exchange: "CBOT",
    },
    FuturesSpec {
        root: "ZC",
        name: "Corn",
        multiplier: 50.0,
        tick_size: 0.25,
        tick_value: 12.5,
        unit: "bu",
        exchange: "CBOT",
    },
    FuturesSpec {
        root: "ZS",
        name: "Soybeans",
        multiplier: 50.0,
        tick_size: 0.25,
        tick_value: 12.5,
        unit: "bu",
        exchange: "CBOT",
    },
    FuturesSpec {
        root: "ZW",
        name: "Wheat",
        multiplier: 50.0,
        tick_size: 0.25,
        tick_value: 12.5,
        unit: "bu",
        exchange: "CBOT",
    },
    FuturesSpec {
        root: "6E",
        name: "Euro FX",
        multiplier: 125_000.0,
        tick_size: 0.000_05,
        tick_value: 6.25,
        unit: "EUR",
        exchange: "CME",
    },
];

const MONTH_CODES: &[u8] = b"FGHJKMNQUVXZ";

/// Strip an optional leading `/` or `./`. The JS uses `replace(/^[./]+/, "")`
/// which collapses any run of slashes/dots at the start.
fn strip_leading(symbol: &str) -> &str {
    symbol.trim_start_matches(['/', '.'])
}

/// Extract the root symbol from a futures symbol.
///
/// Matches the JS regex `^([A-Z0-9]{1,3})[FGHJKMNQUVXZ]\d{1,2}$`
/// after stripping the leading `/` or `./`. Returns the post-strip
/// string when the pattern doesn't match — so non-futures symbols
/// (`AAPL`) and roots without a month/year suffix (`GC`, `/ZB`) round-trip.
#[must_use]
pub fn futures_root(symbol: &str) -> &str {
    let stripped = strip_leading(symbol);
    let bytes = stripped.as_bytes();
    let len = bytes.len();

    // Smallest valid futures symbol is 3 bytes: 1 root + 1 month + 1 year digit.
    // Longest is 6: 3 root + 1 month + 2 year digits.
    if !(3..=6).contains(&len) {
        return stripped;
    }

    // Find the month-code position: it sits at len - {2 or 3} depending on
    // whether the year is 1 or 2 digits. Try both.
    for year_digits in [2_usize, 1] {
        if len <= year_digits + 1 {
            continue;
        }
        let year_start = len - year_digits;
        let month_pos = year_start - 1;
        // 1-3 root chars before the month code.
        let root_len = month_pos;
        if !(1..=3).contains(&root_len) {
            continue;
        }
        // Year digits must all be ASCII digits.
        if !bytes[year_start..].iter().all(u8::is_ascii_digit) {
            continue;
        }
        // Month code must be one of the listed letters.
        if !MONTH_CODES.contains(&bytes[month_pos]) {
            continue;
        }
        // Root chars must be uppercase A-Z or digits.
        if !bytes[..root_len]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        {
            continue;
        }
        return &stripped[..root_len];
    }
    stripped
}

/// Look up the spec for a futures symbol by its root. Returns `None`
/// when the root isn't in [`FUTURES_SPECS`].
#[must_use]
pub fn get_futures_spec(symbol: &str) -> Option<&'static FuturesSpec> {
    let root = futures_root(symbol);
    FUTURES_SPECS.iter().find(|s| s.root == root)
}

/// Whether `symbol` looks like a futures ticker. Matches the JS regex
/// `^[./]` — anything starting with a slash or dot.
#[must_use]
pub fn is_futures_symbol(symbol: &str) -> bool {
    matches!(symbol.as_bytes().first(), Some(b'/' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn futures_root_parses_canonical_forms() {
        assert_eq!(futures_root("/CLM26"), "CL");
        assert_eq!(futures_root("./CLM26"), "CL");
        assert_eq!(futures_root("CLM26"), "CL");
        assert_eq!(futures_root("ESH25"), "ES");
        assert_eq!(futures_root("/6EU24"), "6E");
        assert_eq!(futures_root("/MNQU24"), "MNQ");
    }

    #[test]
    fn futures_root_passes_through_non_futures() {
        // No month-code/year suffix → return post-strip string.
        assert_eq!(futures_root("AAPL"), "AAPL");
        assert_eq!(futures_root("/ZB"), "ZB");
        assert_eq!(futures_root("GC"), "GC");
    }

    #[test]
    fn get_futures_spec_lookup() {
        let cl = get_futures_spec("/CLM26").expect("CL spec");
        assert_eq!(cl.root, "CL");
        assert!((cl.multiplier - 1000.0).abs() < f64::EPSILON);
        assert!((cl.tick_size - 0.01).abs() < f64::EPSILON);
        assert!((cl.tick_value - 10.0).abs() < f64::EPSILON);
        assert_eq!(cl.exchange, "NYMEX");

        let zb = get_futures_spec("/ZB").expect("ZB spec");
        // 1/32 — exact dyadic fraction, comparable bit-for-bit.
        assert!((zb.tick_size - 1.0 / 32.0).abs() < f64::EPSILON);

        let euro = get_futures_spec("/6EU24").expect("6E spec");
        assert!((euro.multiplier - 125_000.0).abs() < f64::EPSILON);

        // MNQ parses as a root but isn't in the spec table.
        assert!(get_futures_spec("/MNQU24").is_none());
        // AAPL isn't a futures symbol.
        assert!(get_futures_spec("AAPL").is_none());
    }

    #[test]
    fn is_futures_symbol_recognizes_prefix() {
        assert!(is_futures_symbol("/CLM26"));
        assert!(is_futures_symbol("./CLM26"));
        assert!(is_futures_symbol("/ZB"));
        assert!(!is_futures_symbol("CLM26"));
        assert!(!is_futures_symbol("ESH25"));
        assert!(!is_futures_symbol("AAPL"));
        assert!(!is_futures_symbol(""));
    }
}
