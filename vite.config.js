import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Read at config-load time (per `vite dev` / `vite build` run, not per HMR
// patch). Major.minor stays manual — bump on milestones; patch is the
// commit count since repo root for a monotonic value; sha + dirty marker
// identify the exact build.
function resolveAppVersion() {
  try {
    const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
    const commits = sh("git rev-list --count HEAD");
    const sha = sh("git rev-parse --short HEAD");
    const dirty = sh("git status --porcelain") ? "-dirty" : "";
    return `0.42.${commits}+${sha}${dirty}`;
  } catch {
    return "0.42.0+unknown";
  }
}

export default defineConfig({
  // Replaced at build time. Strings must be JSON-stringified per Vite docs;
  // otherwise the literal is inlined unquoted and breaks parsing.
  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion()),
  },
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    exclude: ["**/node_modules/**", "**/integration/**"],
  },
});
