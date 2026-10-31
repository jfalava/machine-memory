import { defineConfig } from "oxfmt";

import { fmtBase } from "../oxfmt.config.ts";

export default defineConfig({
  ...fmtBase,
  // astro: true,
  // Prettier formats src/ (see the format script).
  ignorePatterns: ["src/**", "*.astro", "**/*.astro", "*.mdx", "*.md"],
});
