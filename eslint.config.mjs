import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import boundaries from "eslint-plugin-boundaries";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const root = dirname(fileURLToPath(import.meta.url));
const typedFiles = ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts", "packages/**/*.tsx"];
const sourceFiles = ["apps/*/src/**/*.{ts,tsx,js,mjs}", "packages/*/src/**/*.{ts,tsx,js,mjs}"];

// These directions mirror the approved runtime boundaries, including future packages.
const dependencies = {
  domain: [],
  application: ["domain"],
  contracts: [],
  adapters: ["application", "domain", "contracts"],
  ui: [],
  server: ["application", "domain", "contracts", "adapters"],
  web: ["contracts", "ui"],
  workspace: ["contracts"],
  cli: ["contracts"],
  browser: ["contracts"],
};
const apps = new Set(["server", "web", "workspace", "cli", "browser"]);

export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
  },
  {
    ...js.configs.recommended,
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    files: ["*.mjs", "scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: typedFiles })),
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: root },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["apps/web/vite.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["apps/web/tsconfig.node.json"],
        tsconfigRootDir: root,
      },
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: { ...reactHooks.configs.recommended.rules, ...jsxA11y.flatConfigs.recommended.rules },
  },
  {
    files: sourceFiles,
    plugins: { boundaries },
    settings: {
      "boundaries/root-path": root,
      "boundaries/elements": Object.keys(dependencies).map((name) => ({
        type: name,
        pattern: `${apps.has(name) ? "apps" : "packages"}/${name}`,
      })),
      "import/resolver": {
        typescript: {
          project: ["apps/*/tsconfig.json", "packages/*/tsconfig.json"],
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      "boundaries/no-unknown-dependencies": "error",
      "boundaries/no-unknown-files": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          checkAllOrigins: true,
          policies: [
            ...Object.entries(dependencies)
              .filter(([, allowed]) => allowed.length > 0)
              .map(([name, allowed]) => ({
                from: { element: { type: name } },
                allow: { to: { element: { type: allowed } } },
              })),
            {
              from: {
                element: {
                  type: [
                    "contracts",
                    "ui",
                    "web",
                    "adapters",
                    "server",
                    "workspace",
                    "cli",
                    "browser",
                  ],
                },
              },
              allow: { to: { module: { origin: "external" } } },
            },
            {
              from: { element: { type: ["adapters", "server", "workspace", "cli", "browser"] } },
              allow: { to: { module: { origin: "core" } } },
            },
            {
              // Same-package imports are ignored by this rule; cross-package imports must use exports.
              to: { module: { origin: "local" } },
              disallow: { dependency: { source: "!@winston/**" } },
            },
          ],
        },
      ],
    },
  },
  // Prettier owns layout; ESLint owns correctness and architecture.
  prettier,
];
