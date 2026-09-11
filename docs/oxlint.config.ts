import { defineConfig } from "oxlint";

import {
  agentIgnores,
  antiSlopJsPlugins,
  workspaceBase,
} from "../oxlint.config.ts";

export default defineConfig({
  ...workspaceBase,
  jsPlugins: antiSlopJsPlugins(".."),
  ignorePatterns: [
    ...agentIgnores,
    "*.d.ts",
    "**/*.d.ts",
    "dist/**",
    ".astro/**",
    "**/*.astro",
    "*.mdx",
    "*.md",
  ],
  env: { node: true, browser: true, es2022: true },
  globals: {
    ...workspaceBase.globals,
    Astro: "readonly",
    Fragment: "readonly",
  },
});
