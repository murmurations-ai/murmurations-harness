import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Discover tests across all workspace packages.
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Isolate tests per file by default — important because the daemon
    // installs process signal handlers and we do not want them leaking
    // across test files.
    isolate: true,
    // Fast feedback: bail on the first failing file during CI.
    // Developers can override with `pnpm test --no-bail`.
    bail: 0,
    // Sane default timeout; the hello-world gate test is ~5s.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Use the node environment; no DOM needed for core runtime packages.
    environment: "node",
    // Reporter — "default" during local dev, "verbose" in CI via --reporter flag.
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**"],
    },
  },
});
