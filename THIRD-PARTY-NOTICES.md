# Third-Party Notices

Magpie itself is licensed under the [MIT License](LICENSE). It depends on
third-party software distributed under their own licenses. This file documents
the notable dependencies and their licenses. It is informational; the
authoritative license for each dependency is the one shipped with that
dependency.

## NautilusTrader (LGPL-3.0-or-later)

The optional Python research workspace under [`research/`](research/) depends on
[NautilusTrader](https://github.com/nautechsystems/nautilus_trader), which is
licensed under **LGPL-3.0-or-later**.

NautilusTrader is used as an **unmodified dependency**: it is installed from PyPI
(`pip`/`uv`), not vendored into this repository, and not statically linked. The
MIT-licensed Magpie code merely imports it. Under the LGPL, code that uses
an LGPL library in this way (separate, replaceable dependency) is not required to
adopt the LGPL. If you redistribute a combined work, you must preserve the user's
ability to replace NautilusTrader with a modified version, per the LGPL terms.

The TypeScript framework and the Rust `core/` crates have no dependency on
NautilusTrader.

## Other dependencies (permissive)

The JavaScript/TypeScript and Rust dependencies are permissively licensed
(MIT / Apache-2.0 / ISC / BSD). Notable runtime libraries include:

- `duckdb` — MIT
- `nats` / `nats.ws` — Apache-2.0
- `lightweight-charts` — Apache-2.0
- `prom-client` — Apache-2.0
- `ws` — MIT
- `@stoqey/ib` — MIT

Run `npm ls` / `cargo deny check licenses` / `uv pip list` for the complete,
version-pinned dependency trees.
