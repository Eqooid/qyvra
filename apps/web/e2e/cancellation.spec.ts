import { test, expect } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { register, password } from "./auth"
import { png } from "./fixtures"

const storedFiles = () =>
  Number(
    execFileSync(
      process.execPath,
      [
        resolve(
          process.env.E2E_AI_ENABLED === "true"
            ? "../../infrastructure/e2e/ai-run.cjs"
            : "../../infrastructure/e2e/run.cjs"
        ),
        "storage-count",
      ],
      { encoding: "utf8" }
    ).trim()
  )
test("active upload cancellation aborts the request and cleans partial storage", async ({
  page,
  context,
}) => {
  await register(page, `cancel-${randomUUID()}@example.invalid`, password())
  const before = storedFiles()
  await page.goto("/documents/upload")
  const bytes = png(Date.now(), 600, 600)
  await page
    .getByLabel("File *", { exact: true })
    .setInputFiles({ name: "cancel.png", mimeType: "image/png", buffer: bytes })
  await page
    .getByLabel("Title *", { exact: true })
    .fill("Cancelled in progress")
  await page.getByLabel("Document type *", { exact: true }).fill("OTHER")
  const cdp = await context.newCDPSession(page)
  // Throttle a real connection; do not intercept or mock any request or response.
  await cdp.send("Network.enable")
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 100,
    downloadThroughput: 1000000,
    uploadThroughput: 20000,
  })
  const failed = page.waitForEvent(
    "requestfailed",
    (request) =>
      request.method() === "POST" && request.url().endsWith("/api/v1/documents")
  )
  try {
    await page
      .getByRole("button", { name: "Upload document", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Cancel upload", exact: true })
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Cancel upload", exact: true })
      .click()
    expect((await failed).failure()?.errorText).toMatch(/ABORTED/)
    await expect(
      page.getByRole("button", { name: "Upload document", exact: true })
    ).toBeEnabled()
  } finally {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await cdp.detach()
  }
  await page.goto("/documents")
  await expect(
    page.getByText("Cancelled in progress", { exact: true })
  ).toHaveCount(0)
  await expect.poll(storedFiles).toBe(before)
})
