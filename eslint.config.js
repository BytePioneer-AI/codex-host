import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typeScriptFiles = ["packages/**/*.ts", "tests/**/*.ts"];
const javaScriptFiles = [
  "*.config.js",
  "packages/**/scripts/**/*.mjs",
  "packages/repository-automation/**/*.mjs",
  "scripts/**/*.mjs",
  "tests/**/*.mjs",
  "tools/**/*.mjs",
];

export default [
  {
    ignores: [
      ".codexhost/**",
      ".pi/**",
      ".work/**",
      // Independently installed Next.js site has its own ESLint configuration.
      "apps/wiki/**",
      "build/**",
      "coverage/**",
      "node_modules/**",
      "openspec/**",
      "reference/**",
      "target/**",
      "**/dist/**",
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
    files: ["packages/**/test/**/*.ts", "tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    files: ["packages/renderer-extension/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
