import type { Config } from "prettier";

// Prettier owns formatting; ESLint owns correctness. Style is Prettier's defaults.
const config: Config = {
  // Sorts package.json keys (via sort-package-json) whenever Prettier formats one.
  plugins: ["prettier-plugin-packagejson"],
};

export default config;
