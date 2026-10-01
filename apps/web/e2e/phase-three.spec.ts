import { test, expect } from "@playwright/test"
import { randomUUID, createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { png } from "./fixtures"
import { password, register } from "./auth"

test("Phase 3: upload and new version reach durable integrity completion through Nginx", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000)
  const run = randomUUID()
  const first = png(Date.now())
  const second = png(Date.now() + 1)
  const errors: string[] = []
  page.on("pageerror", () => errors.push("Uncaught browser error"))
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 500)
      errors.push(`API ${response.status()}`)
  })

  await register(page, `phase3-${run}@example.invalid`, password())
  await page.goto("/documents/upload")
  await page.getByLabel("Title *", { exact: true }).fill(`Integrity ${run}`)
  await page.getByLabel("File *", { exact: true }).setInputFiles({
    name: `first-${run}.png`,
    mimeType: "image/png",
    buffer: first,
  })
  await page
    .getByRole("button", { name: "Upload document", exact: true })
    .click()
  await expect(page).toHaveURL(/\/documents$/)
  await page.getByRole("link", { name: `Integrity ${run}` }).click()
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/)
  const documentId = new URL(page.url()).pathname.split("/").at(-1)!

  async function currentVersion() {
    const response = await page.request.get(`/api/v1/documents/${documentId}`)
    expect(response.status()).toBe(200)
    return (await response.json()).data.currentVersion.id as string
  }
  async function processing(versionId: string) {
    const response = await page.request.get(
      `/api/v1/documents/${documentId}/versions/${versionId}/processing`
    )
    expect(response.status()).toBe(200)
    return (await response.json()).data as {
      documentId: string
      documentVersionId: string
      jobs: { id: string; jobType: string; status: string; attempts: number }[]
    }
  }
  const firstVersion = await currentVersion()
  await expect
    .poll(async () => (await processing(firstVersion)).jobs[0]?.status, {
      timeout: 60000,
    })
    .toBe("COMPLETED")
  const firstStatus = await processing(firstVersion)
  expect(firstStatus.documentVersionId).toBe(firstVersion)
  expect(firstStatus.jobs).toHaveLength(1)
  expect(firstStatus.jobs[0]).toMatchObject({
    jobType: "VERIFY_STORED_FILE",
    status: "COMPLETED",
    attempts: 1,
  })
  await expect(page.getByText("Integrity verified")).toBeVisible()

  const downloadEvent = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download current file" }).click()
  const downloaded = await downloadEvent
  const bytes = await readFile((await downloaded.path())!)
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    createHash("sha256").update(first).digest("hex")
  )

  await page.getByRole("link", { name: "Version history" }).click()
  await page
    .getByRole("button", { name: "Upload new version", exact: true })
    .click()
  await page.getByLabel("New version file *").setInputFiles({
    name: `second-${run}.png`,
    mimeType: "image/png",
    buffer: second,
  })
  await page
    .getByRole("button", { name: "Upload new version", exact: true })
    .last()
    .click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: "Confirm upload new version",
    })
    .click()
  await expect(
    page.getByRole("button", { name: "Inspect version 2" })
  ).toBeVisible()
  const secondVersion = await currentVersion()
  expect(secondVersion).not.toBe(firstVersion)
  await expect
    .poll(async () => (await processing(secondVersion)).jobs[0]?.status, {
      timeout: 60000,
    })
    .toBe("COMPLETED")
  const secondStatus = await processing(secondVersion)
  expect(secondStatus.jobs).toHaveLength(1)
  expect(secondStatus.jobs[0].id).not.toBe(firstStatus.jobs[0].id)
  expect((await processing(firstVersion)).jobs[0].status).toBe("COMPLETED")
  await page.getByRole("button", { name: "Inspect version 1" }).click()
  await expect(
    page
      .getByRole("region", { name: "Version 1 metadata" })
      .getByText("Integrity verified")
  ).toBeVisible()

  const foreign = await browser.newContext()
  try {
    const foreignPage = await foreign.newPage()
    await register(
      foreignPage,
      `foreign-phase3-${run}@example.invalid`,
      password()
    )
    const denied = await foreignPage.request.get(
      `/api/v1/documents/${documentId}/versions/${firstVersion}/processing`
    )
    expect(denied.status()).toBe(404)
  } finally {
    await foreign.close()
  }
  const anonymous = await browser.newContext()
  try {
    expect(
      (
        await anonymous.request.get(
          `/api/v1/documents/${documentId}/versions/${firstVersion}/processing`
        )
      ).status()
    ).toBe(401)
  } finally {
    await anonymous.close()
  }
  expect(errors).toEqual([])
})
