/**
 * vitest.config.ts
 *
 * Vitest test runner configuration for the Aurora Energy ESG Pipeline.
 * Tests live in the top-level `tests/` directory and import directly from
 * `../src/**` using relative paths.
 *
 * Vitest uses esbuild for TypeScript transformation — it honours tsconfig
 * compilerOptions for type resolution but does not block on strict errors
 * during test execution, allowing the test suite to focus on runtime behaviour.
 */

import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    /**
     * Inject Vitest globals (describe, it, expect, vi, beforeEach, afterEach)
     * without explicit imports in each test file.
     */
    globals: true,

    /** Run tests in a standard Node.js environment (no DOM). */
    environment: "node",

    /** File patterns to include as test suites. */
    include: ["tests/**/*.test.ts"],

    /** Maximum concurrency for test files; set to 1 to serialise DB-touching tests. */
    maxConcurrency: 4,

    /**
     * Timeout per individual test.  Set higher than the default (5 s) to
     * accommodate slow mock LLM invocations in agents.test.ts.
     */
    testTimeout: 15_000,

    /**
     * Coverage configuration.
     * Run: `npm run test:coverage`
     */
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/db/seed.ts",
        "src/server.ts",
        "src/**/*.d.ts",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
    },
  },

  /**
   * Alias resolution for path aliases declared in tsconfig.json.
   * Vitest uses Vite's resolver, which does not pick up tsconfig paths
   * automatically — we mirror them here.
   */
  resolve: {
    alias: {
      "@db": resolve(__dirname, "src/db"),
      "@agents": resolve(__dirname, "src/agents"),
      "@types-local": resolve(__dirname, "src/types"),
      "@trpc-router": resolve(__dirname, "src/trpc"),
    },
  },
});
