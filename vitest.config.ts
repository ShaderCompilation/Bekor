import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/*.integration.test.ts",
            "**/*.runner.test.ts",
          ],
        },
      },
      {
        test: {
          name: "integration",
          include: ["**/*.integration.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 30000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "runner",
          include: ["**/*.runner.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 120000,
          fileParallelism: false,
        },
      },
    ],
  },
});
