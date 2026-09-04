import { defineConfig } from "oxlint";

import { agentIgnores, antiSlopJsPlugins, workspaceBase } from "../oxlint.config.ts";

// Object spread instead of oxlint `extends`: extends-based inheritance drops
// env/globals/overrides from the parent config.
export default defineConfig({
  ...workspaceBase,
  jsPlugins: antiSlopJsPlugins(".."),
  ignorePatterns: [...agentIgnores, "*.d.ts", "**/*.d.ts", "tests/**"],
});
