import js from "@eslint/js";
import tanstackRouter from "@tanstack/eslint-plugin-router";
import prettier from "eslint-config-prettier/flat";
import betterTailwind from "eslint-plugin-better-tailwindcss";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  // TanStack Router generates this.
  globalIgnores(["**/routeTree.gen.ts", "apps/web/dist/"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      // Not in the presets: a switch over a union must handle every member.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
    languageOptions: {
      parserOptions: {
        // Each file is type-checked with its nearest tsconfig.json.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // The site and its design system: React hooks (with the React Compiler
  // rules) and Tailwind class checks against the site's stylesheet, which
  // imports the design system's tokens (docs/design.md §8b).
  {
    files: ["apps/web/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
    extends: [
      reactHooks.configs.flat.recommended,
      betterTailwind.configs["recommended-error"],
    ],
    settings: {
      "better-tailwindcss": {
        cwd: "./apps/web",
        entryPoint: "src/styles/app.css",
        // Lets it turn pixel values into the spacing scale (h-[30px] → h-7.5).
        rootFontSize: 16,
      },
    },
    rules: {
      "better-tailwindcss/enforce-shorthand-classes": "error",
      // Prettier owns class order, line wrapping and whitespace.
      "better-tailwindcss/enforce-consistent-class-order": "off",
      "better-tailwindcss/enforce-consistent-line-wrapping": "off",
      "better-tailwindcss/no-unnecessary-whitespace": "off",
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [tanstackRouter.configs["flat/recommended"]],
  },
  // Last: turns off rules that overlap with Prettier's formatting.
  prettier,
);
