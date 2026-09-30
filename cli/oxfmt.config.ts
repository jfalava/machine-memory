import { defineConfig } from "oxfmt";

import { fmtBase } from "../oxfmt.config.ts";

export default defineConfig({
  ...fmtBase,
  sortPackageJson: {
    sortScripts: true,
  },
  ignorePatterns: [],
});
