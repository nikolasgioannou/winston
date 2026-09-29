import type { Config } from "prettier";
import type { PluginOptions as TailwindOptions } from "prettier-plugin-tailwindcss";

// Prettier owns formatting; ESLint owns correctness. Style is Prettier's defaults.
const config: Config & TailwindOptions = {
  // Sorts package.json keys (via sort-package-json) whenever Prettier formats one.
  // The Tailwind plugin sorts class names and must come last.
  plugins: ["prettier-plugin-packagejson", "prettier-plugin-tailwindcss"],
  // Class order comes from the site's stylesheet (Tailwind v4, CSS-first).
  tailwindStylesheet: "./apps/web/src/styles/app.css",
  tailwindFunctions: ["cn", "clsx", "cva"],
};

export default config;
