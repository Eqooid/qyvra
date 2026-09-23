import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  timeout: 240000,
  expect: { timeout: 15000 },
  reporter: [["./e2e/reporter.ts"]],
  use: {
    actionTimeout: 15000,
    navigationTimeout: 30000,
    baseURL: "http://localhost:18080",
    browserName: "chromium",
    // Traces contain request cookies/passwords; intentionally do not record them.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
})
