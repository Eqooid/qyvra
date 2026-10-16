import { defineConfig } from "@playwright/test"
/** Real Chromium + production Next.js; API responses are explicitly mocked. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "search.mock.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "list",
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 3115",
    url: "http://127.0.0.1:3115",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  use: {
    baseURL: "http://127.0.0.1:3115",
    browserName: "chromium",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
})
