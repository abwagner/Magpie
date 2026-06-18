// Ambient declarations for non-TS assets imported as side effects.
// CSS imports (project styles + @fontsource font CSS) are bundled
// by Vite; TypeScript only needs to know the modules exist.

declare module "*.css";
declare module "@fontsource/*";

// plotly.js-basic-dist-min ships no .d.ts. CurveChart treats Plotly as
// a structural surface; this declaration just unblocks the dynamic
// import.
declare module "plotly.js-basic-dist-min";

// Build-time constant injected by Vite's `define` (vite.config.js).
// Format: `<major>.<minor>.<commit-count>+<short-sha>[-dirty]`.
declare const __APP_VERSION__: string;
