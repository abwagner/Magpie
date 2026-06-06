/* tslint:disable */
/* eslint-disable */

/**
 * Install a panic hook that routes Rust panics to `console.error` rather
 * than letting them silently abort the WASM instance. Call once from JS
 * after `init()`. Cheap — installs a single handler.
 */
export function installPanicHook(): void;

/**
 * Solve the LP / MIP described by `model`.
 *
 * `model` is a JS object matching the `javascript-lp-solver` shape
 * (`{optimize, opType, constraints, variables, ints}`) — the same shape
 * the legacy `src/lib/lp-optimizer.js` already constructs. Result is a JS
 * object with `{feasible, objective_value, values}` (camelCase
 * `objectiveValue` is rendered as `snake_case` `objective_value` to match
 * the Python wrapper).
 *
 * # Errors
 *
 * Returns a JS `Error` when the model has a malformed shape (caught by
 * serde) or when a variable references an undeclared constraint row.
 * Infeasible / unbounded is **not** an error — the returned object has
 * `feasible: false`.
 */
export function solve(model: any): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly installPanicHook: () => void;
    readonly solve: (a: any) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
