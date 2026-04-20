// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier/flat";

/**
 * Flat ESLint config for the Murmuration Harness monorepo.
 *
 * Per ADR-0009: ESLint + typescript-eslint (recommended-type-checked
 * + strict-type-checked) + Prettier for formatting (disabled here
 * via eslint-config-prettier so Prettier owns formatting entirely).
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.tsbuildinfo",
      // Example agents are reference material; they don't need to follow
      // the same strict typing rules since they are not part of the
      // published product.
      "examples/**",
      // Bundled extensions are plain JS (.mjs) loaded at runtime via
      // the extension loader — they don't participate in the TS project.
      "packages/*/src/builtin-extensions/**",
      // Bundled governance plugins (v0.5.0 Milestone 4.6) — plain .mjs
      // shipped with the CLI and copied into operator repos. Not part
      // of the TS project; format and runtime-check only.
      "packages/*/src/governance-plugins/**",
      // Bundled CLI examples (v0.5.0 Milestone 4) — template .mjs files
      // inside example trees are not part of the TS project either.
      "packages/*/src/examples/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Prefer `type` over `interface` is an opinion we do not hold.
      "@typescript-eslint/consistent-type-definitions": "off",
      // We have plenty of legitimate `void` operator uses in the daemon
      // for fire-and-forget promises; the rule is too noisy.
      "@typescript-eslint/no-confusing-void-expression": "off",
      // Allow intentional `_`-prefixed unused args.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // We use `readonly` / `as const` aggressively; no need for immediate
      // non-null assertion lint.
      "@typescript-eslint/no-non-null-assertion": "warn",
      // Allow `Record<string, unknown>` etc. without forcing `object`.
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
    },
  },
  // Test files relax a few rules — tests often assert on any, inspect
  // internals, and use non-null assertions on fixture data.
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  // Prettier config must be last to override any stylistic rules
  // that would fight with Prettier.
  prettierConfig,
);
