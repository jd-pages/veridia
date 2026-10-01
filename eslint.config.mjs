import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  globalIgnores([
    ".next/**",
    ".next-preview-*/**",
    ".playwright/**",
    "node_modules/**",
    // Licensed byte-exact compiled upstream reference, not application/test
    // implementation. Hash and behavior remain exercised by reporter tests.
    "tests/fixtures/next-trace-original.cjs",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "dist/**",
    "dist-installer/**",
    "desktop-runtime/**",
    "release/**",
    "artifacts/**",
    "backups/**",
    "logs/**",
    "outputs/**",
    ".release-work/**",
    ".desktop-test-*/**",
    "extension/**",
    "examples/**",
    "build/**",
    "worker/**",
    "db/**",
    "next-env.d.ts"
  ])
]);
