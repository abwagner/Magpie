// ── ESLint flat config ────────────────────────────────────────────
// Migrated from .eslintrc.cjs for ESLint v9+ (the v8 RC format is no
// longer supported by the CLI).
//
// Lints .ts/.tsx only. Legacy .js/.jsx files are slated for deletion
// in the JSX → TS migration; see docs/MIGRATION-JSX-TS.md. The
// `**/*.{js,jsx}` ignore pattern goes away once the migration is
// done.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "data/**",
      "models/**",
      // Transitional — drop these globs once the JSX → TS migration lands.
      "**/*.js",
      "**/*.jsx",
      "**/*.cjs",
      "**/*.mjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Several scripts use `process.exit(...)` to terminate switch
      // cases. ESLint can't prove `never`-return without type info, so
      // it flags the next case as fallthrough. TypeScript catches real
      // fallthroughs via `noFallthroughCasesInSwitch`; the eslint rule
      // would only produce false positives here.
      "no-fallthrough": "off",
      "@typescript-eslint/no-explicit-any": "error",
      // Downgraded to warn during the JSX → TS migration: the existing
      // TS surface has ~60 pre-existing unused-var hits in legacy code
      // and we don't want pre-commit to block touch-unrelated commits.
      // Restore to "error" once the backlog is clean (tracked in
      // docs/MIGRATION-JSX-TS.md, "Phase E").
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
