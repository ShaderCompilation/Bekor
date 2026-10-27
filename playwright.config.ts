import { defineConfig, devices } from "@playwright/test";

// Browser journeys run against an already running stack (web + API + worker + PostgreSQL +
// runner); see docs/runbooks/development.md. Nothing here starts servers or mocks the API.
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BEKOR_E2E_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
