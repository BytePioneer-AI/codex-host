import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typeScriptFiles = ["packages/**/*.ts"];
const javaScriptFiles = [
  "*.config.js",
  "packages/**/scripts/**/*.mjs",
  "packages/repository-automation/**/*.mjs",
  "scripts/**/*.mjs",
  "tools/**/*.mjs",
];

export default [
  {
    ignores: [
      ".codexhost/**",
      ".kilo/**",
      ".pi/**",
      ".work/**",
      // Independently installed Next.js site has its own ESLint configuration.
      "apps/wiki/**",
      "build/**",
      "coverage/**",
      "node_modules/**",
      "openspec/**",
      "reference/**",
      "**/target/**",
      "**/dist/**",
      "packages/**/test/**",
      "tests/**",
      "**/*.test.ts",
      "**/*.test.mjs",
    ],
  },
  {
    ...js.configs.recommended,
    files: javaScriptFiles,
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typeScriptFiles,
  })),
  {
    files: typeScriptFiles,
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["packages/renderer-extension/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
