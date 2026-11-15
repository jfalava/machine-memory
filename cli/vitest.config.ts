import viteTsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [viteTsConfigPaths({ projects: ["./tsconfig.json"] })],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Integration cases launch several Bun processes while all workspaces test.
    testTimeout: 15000,
    // Writes record the agent harness they run under; the tests must not
    // depend on which one launched them. A test sets its own to check it.
    env: { MACHINE_MEMORY_AGENT: "" },
  },
});
