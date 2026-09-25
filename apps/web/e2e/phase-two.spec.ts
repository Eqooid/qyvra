import { test, expect, type APIRequestContext } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { png } from "./fixtures"
import { password, register } from "./auth"
import { pdfFixture } from "../../../apps/api/test/upload.fixture"

const mutationHeaders = {
  Origin: "http://localhost:18080",
  "X-CSRF-Protection": "1",
}

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    await page.screenshot({
      path: info.outputPath("failure.png"),
      mask: [page.locator('input[type="password"]')],
      fullPage: true,
    })
})

async function createTag(api: APIRequestContext, name: string) {
  const response = await api.post("/api/v1/tags", {
    headers: mutationHeaders,
    data: { name },
  })
  expect(response.status()).toBe(201)
  return (await response.json()).data.id as string
}

async function createDocument(
  api: APIRequestContext,
  title: string,
  filename: string,
  tagIds: string[],
  seed: number
) {
  const pdf = filename.endsWith(".pdf")
  const response = await api.post("/api/v1/documents", {
    headers: { ...mutationHeaders, "Idempotency-Key": randomUUID() },
    multipart: {
      title,
      documentType: "OTHER",
      tagIds: JSON.stringify(tagIds),
      file: {
        name: filename,
        mimeType: pdf ? "application/pdf" : "image/png",
        buffer: pdf ? pdfFixture(String(seed)) : png(seed),
      },
    },
  })
  expect(response.status()).toBe(201)
  return (await response.json()).data.id as string
}

test("v1.1.0 upload offers an optional description through Nginx", async ({
  page,
}) => {
  const run = randomUUID()
  const errors: string[] = []
  page.on("pageerror", () => errors.push("Uncaught browser error"))
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 500)
      errors.push(`API ${response.status()}`)
  })
  await register(page, `v11-${run}@example.invalid`, password())
  await page.goto("/documents/upload")
  await expect(page.getByLabel("Description (optional)")).toBeVisible()
  await page.getByLabel("Title *", { exact: true }).fill(`E2E report ${run}`)
  await page.getByLabel("File *", { exact: true }).setInputFiles({
    name: `report-${run}.png`,
    mimeType: "image/png",
    buffer: png(Date.now()),
  })
  await page
    .getByLabel("Description (optional)")
    .fill("Quarterly financial report")
  await page
    .getByRole("button", { name: "Upload document", exact: true })
    .click()
  await expect(page).toHaveURL(/\/documents$/)
  await page
    .getByRole("link", { name: `E2E report ${run}`, exact: true })
    .click()
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/)
  await expect(page.getByText("Quarterly financial report")).toBeVisible()
  await page.reload()
  await expect(page.getByText("Quarterly financial report")).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Current version" })
  ).toBeVisible()
  await expect(
    page.getByText(`report-${run}.png`, { exact: true })
  ).toBeVisible()

  await page.getByRole("button", { name: "Edit metadata" }).click()
  await page
    .getByLabel("Description (optional)")
    .fill("Revised financial report")
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByText("Revised financial report")).toBeVisible()
  await page.reload()
  await expect(page.getByText("Revised financial report")).toBeVisible()

  await page.getByRole("button", { name: "Edit metadata" }).click()
  await page.getByLabel("Description (optional)").fill("")
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByText("No description", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText("No description", { exact: true })).toBeVisible()

  await page.getByRole("link", { name: "Version history", exact: true }).click()
  await page
    .getByRole("button", { name: "Upload new version", exact: true })
    .click()
  await page.getByLabel("New version file *").setInputFiles({
    name: `final-${run}.png`,
    mimeType: "image/png",
    buffer: png(Date.now() + 1),
  })
  await page
    .getByRole("button", { name: "Upload new version", exact: true })
    .last()
    .click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm upload new version" })
    .click()
  await expect(
    page.getByRole("button", { name: "Inspect version 2" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Inspect version 1" })
  ).toBeVisible()
  await expect(page.getByText("Current / latest", { exact: true })).toHaveCount(
    1
  )
  await page.goBack()
  await expect(
    page.getByRole("heading", { name: "Current version" })
  ).toBeVisible()
  await expect(
    page.getByText(`final-${run}.png`, { exact: true })
  ).toBeVisible()
  await expect(page.getByText("v2", { exact: true })).toBeVisible()
  await page.goto("/documents")
  await expect(
    page.getByRole("link", { name: `E2E report ${run}` })
  ).toBeVisible()
  await expect(
    page.getByText(`final-${run}.png`, { exact: true })
  ).toBeVisible()
  expect(errors).toEqual([])
})

test("v1.1.0 catalog filters, sorts, cursors and ownership work through Nginx", async ({
  page,
  browser,
}) => {
  test.setTimeout(300000)
  const run = randomUUID()
  const errors: string[] = []
  page.on("pageerror", () => errors.push("Uncaught browser error"))
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 500)
      errors.push(`API ${response.status()}`)
  })
  await register(page, `catalog-${run}@example.invalid`, password())
  const finance = await createTag(page.request, `Finance ${run}`)
  const year = await createTag(page.request, `Year ${run}`)
  const targetTitles = Array.from(
    { length: 5 },
    (_, i) => `Report ${i + 1} ${run}`
  )
  const oldFilename = `old-report-${run}.png`
  const currentFilename = `final-report-${run}.pdf`
  const firstId = await createDocument(
    page.request,
    targetTitles[0],
    oldFilename,
    [finance, year],
    Date.now()
  )
  const version = await page.request.post(
    `/api/v1/documents/${firstId}/versions`,
    {
      headers: { ...mutationHeaders, "Idempotency-Key": randomUUID() },
      multipart: {
        file: {
          name: currentFilename,
          mimeType: "application/pdf",
          buffer: pdfFixture(run),
        },
      },
    }
  )
  expect(version.status()).toBe(201)
  for (let i = 1; i < targetTitles.length; i++)
    await createDocument(
      page.request,
      targetTitles[i],
      `report-${i + 1}-${run}.pdf`,
      [finance, year],
      Date.now() + i
    )
  await createDocument(
    page.request,
    `Finance only ${run}`,
    `finance-${run}.pdf`,
    [finance],
    Date.now() + 10
  )
  await createDocument(
    page.request,
    `Year only ${run}`,
    `year-${run}.png`,
    [year],
    Date.now() + 11
  )

  const other = await browser.newContext()
  const foreignPage = await other.newPage()
  let foreignId: string
  try {
    await register(foreignPage, `foreign-${run}@example.invalid`, password())
    foreignId = await createDocument(
      foreignPage.request,
      `Foreign report ${run}`,
      currentFilename,
      [],
      Date.now() + 12
    )
  } finally {
    await other.close()
  }

  await page.goto("/documents?limit=2")
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible()
  await expect(page.getByText(`Foreign report ${run}`)).toHaveCount(0)

  const filename = page.getByRole("searchbox", { name: "Current filename" })
  await filename.fill("final-report")
  await expect(page).toHaveURL(/filename=final-report/)
  await expect(page.getByRole("link", { name: targetTitles[0] })).toBeVisible()
  await expect(page.getByText(`Foreign report ${run}`)).toHaveCount(0)
  await filename.fill("old-report")
  await expect(page).toHaveURL(/filename=old-report/)
  await expect(
    page.getByRole("heading", { name: "No matching documents" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear all filters" }).click()
  await expect(page).toHaveURL(/\/documents$/)

  await page.goto("/documents?limit=2&filename=final-report")
  await page.getByRole("combobox", { name: "Current file type" }).click()
  await page.getByRole("option", { name: "PDF" }).click()
  await expect(page).toHaveURL(/mimeType=application%2Fpdf/)
  await expect(page.getByRole("link", { name: targetTitles[0] })).toBeVisible()
  await page.getByRole("combobox", { name: "Current file type" }).click()
  await page.getByRole("option", { name: "PNG image" }).click()
  await expect(
    page.getByRole("heading", { name: "No matching documents" })
  ).toBeVisible()

  await page.goto("/documents?limit=2")
  const tagFilter = page.getByRole("button", { name: "Tags (match all)" })
  await tagFilter.click()
  await page.getByRole("checkbox", { name: `Finance ${run}` }).click()
  await expect(page).toHaveURL(/tagIds=/)
  const secondTag = page.getByRole("checkbox", { name: `Year ${run}` })
  if (!(await secondTag.isVisible())) await tagFilter.click()
  await secondTag.click()
  await expect(page.getByLabel("Active filters")).toContainText(
    `Finance ${run}`
  )
  await expect(page.getByLabel("Active filters")).toContainText(`Year ${run}`)
  await page.keyboard.press("Escape")

  const today = new Date().toISOString().slice(0, 10)
  await page.getByLabel("Created from").fill(today)
  await expect(page).toHaveURL(new RegExp(`createdFrom=${today}`))
  await page.getByLabel("Created to").fill(today)
  await expect(page).toHaveURL(new RegExp(`createdTo=${today}`))
  await page.getByLabel("Updated from").fill(today)
  await expect(page).toHaveURL(new RegExp(`updatedFrom=${today}`))
  await page.getByLabel("Updated to").fill(today)
  await expect(page).toHaveURL(new RegExp(`updatedTo=${today}`))

  await page.getByRole("combobox", { name: "Current file type" }).click()
  await page.getByRole("option", { name: "PDF" }).click()
  await page.getByRole("searchbox", { name: "Current filename" }).fill("report")
  await expect(page).toHaveURL(/filename=report/)
  await page.getByRole("combobox", { name: "Sort by" }).click()
  await page.getByRole("option", { name: "Title" }).click()
  await page.getByRole("combobox", { name: "Sort direction" }).click()
  await page.getByRole("option", { name: "Ascending" }).click()
  await expect(page).toHaveURL(/sort=title/)
  const tableLinks = () =>
    page.getByRole("table").getByRole("link").allTextContents()
  const pageOne = await tableLinks()
  expect(pageOne).toEqual(targetTitles.slice(0, 2))
  await page.getByRole("button", { name: "Next page" }).click()
  await expect(page).toHaveURL(/cursor=/)
  await expect(page.getByText(/Page 2.*Up to/)).toBeVisible()
  await expect(page.getByRole("link", { name: targetTitles[2] })).toBeVisible()
  const pageTwo = await tableLinks()
  await page.getByRole("button", { name: "Next page" }).click()
  await expect(page.getByText(/Page 3.*Up to/)).toBeVisible()
  await expect(page.getByRole("link", { name: targetTitles[4] })).toBeVisible()
  const pageThree = await tableLinks()
  expect([...pageOne, ...pageTwo, ...pageThree]).toEqual(targetTitles)
  expect(new Set([...pageOne, ...pageTwo, ...pageThree]).size).toBe(5)
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled()
  await page.getByRole("button", { name: "Previous page" }).click()
  await expect(page.getByText(/Page 2.*Up to/)).toBeVisible()
  await expect(page.getByRole("link", { name: targetTitles[2] })).toBeVisible()
  expect(await tableLinks()).toEqual(pageTwo)
  await page.getByRole("button", { name: "Previous page" }).click()
  await expect(page.getByText(/Page 1.*Up to/)).toBeVisible()
  await expect(page.getByRole("link", { name: targetTitles[0] })).toBeVisible()
  expect(await tableLinks()).toEqual(pageOne)

  await page.getByRole("button", { name: "Next page" }).click()
  await expect(page).toHaveURL(/cursor=/)
  await page.getByRole("combobox", { name: "Sort direction" }).click()
  await page.getByRole("option", { name: "Descending" }).click()
  await expect(page).toHaveURL(/sort=-title/)
  expect(new URL(page.url()).searchParams.has("cursor")).toBe(false)
  await expect(
    page.getByRole("button", { name: "Previous page" })
  ).toBeDisabled()
  await expect(page.getByRole("table").getByRole("link").first()).toHaveText(
    targetTitles[4]
  )
  await page.getByRole("button", { name: "Next page" }).click()
  await expect(page).toHaveURL(/cursor=/)
  await page
    .getByRole("searchbox", { name: "Current filename" })
    .fill("missing")
  await expect(page).toHaveURL(/filename=missing/)
  expect(new URL(page.url()).searchParams.has("cursor")).toBe(false)
  await expect(
    page.getByRole("heading", { name: "No matching documents" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear all filters" }).click()
  await expect(page).toHaveURL(/\/documents$/)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  await page.getByLabel("Created to").fill(yesterday)
  await expect(page).toHaveURL(new RegExp(`createdTo=${yesterday}`))
  await expect(
    page.getByRole("heading", { name: "No matching documents" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear all filters" }).click()
  await page.getByLabel("Updated to").fill(yesterday)
  await expect(page).toHaveURL(new RegExp(`updatedTo=${yesterday}`))
  await expect(
    page.getByRole("heading", { name: "No matching documents" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear all filters" }).click()
  for (const [label, sort] of [
    ["Created date", "-createdAt"],
    ["Updated date", "-updatedAt"],
    ["Current file size", "-fileSize"],
  ]) {
    await page.getByRole("combobox", { name: "Sort by" }).click()
    await page.getByRole("option", { name: label }).click()
    await expect(page).toHaveURL(new RegExp(`sort=${sort}`))
    await expect(
      page.getByRole("table").getByRole("link").first()
    ).toBeVisible()
  }
  await page.goto(`/documents/${foreignId}`)
  await expect(page.getByText(/Document not found/)).toBeVisible()
  expect(errors).toEqual([])
})
