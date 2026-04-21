import { defineConfig } from "vitest/config";

/**
 * Vitest config for @toncast/tx-sdk.
 *
 * Test discovery: `tests/**` only (co-located test files are not used in
 * this package).
 *
 * Coverage: v8 provider, thresholds enforced. This SDK builds TonConnect
 * transaction parameters that move real value on-chain, so the bar is set
 * high — a regression that drops coverage below these floors blocks CI.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Re-exports / types only — nothing to execute.
        "src/index.ts",
        "src/jetton/index.ts",
        "src/types.ts",
        // Tact-generated bindings — copied verbatim from the contract
        // repo, tested transitively via `payload.test.ts`.
        "src/contracts/**",
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
