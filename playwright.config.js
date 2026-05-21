import { defineConfig } from "@playwright/test";

/**
 * Playwright config for popup E2E tests.
 *
 * MV3 extensions only load under a persistent browser context, so each test
 * spec defines its own context fixture (see tests/e2e/fixtures.js). We keep
 * Playwright's own `use.browserName` etc. minimal — the heavy lifting is in
 * the per-test launch.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.js$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // chrome extension contexts don't share well
  workers: 1,
  reporter: process.env.CI ? "list" : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
