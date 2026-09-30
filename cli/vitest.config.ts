import viteTsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [viteTsConfigPaths({ projects: ["./tsconfig.json"] })],
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    environment: "node",
    // Integration cases launch several Bun processes while all workspaces test.
    testTimeout: 15000,
  },
});
