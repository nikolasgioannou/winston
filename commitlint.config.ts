import { RuleConfigSeverity, type UserConfig } from "@commitlint/types";

const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Commit messages are a single subject line.
    "body-empty": [RuleConfigSeverity.Error, "always"],
    "footer-empty": [RuleConfigSeverity.Error, "always"],
  },
};

export default config;
