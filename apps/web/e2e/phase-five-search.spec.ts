import { test, expect } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { register, password } from "./auth"
import { textPdf } from "./pdf-fixture"

// Opt-in only on an isolated, already configured Phase 5 Nginx stack.
test.skip(
  process.env.E2E_SEARCH_ENABLED !== "true" ||
    !/^qyvra-e2e(?:-[a-z0-9-]+)?$/.test(process.env.E2E_PROJECT_NAME ?? ""),
  "Requires an isolated Phase 5 stack with enrollment, workers and keyword serving enabled"
)
test("live Nginx: PDF publication, page source, private suggestions, second-user isolation and archive", async ({
  page,
  browser,
  baseURL,
}) => {
  const run = randomUUID(),
    title = `Search workflow ${run}`
  const foreign = await browser.newContext()
  try {
    await register(page, `search-a-${run}@example.invalid`, password())
    await page.goto("/documents/upload")
    await page.getByLabel("Title *", { exact: true }).fill(title)
    await page.getByLabel("File *", { exact: true }).setInputFiles({
      name: `${run}.pdf`,
      mimeType: "application/pdf",
      buffer: textPdf([
        "First page without the target.",
        "lexicalneedle is on the second page.",
      ]),
    })
    await page
      .getByRole("button", { name: "Upload document", exact: true })
      .click()
    await expect(page).toHaveURL(/\/documents$/)
    await page.getByRole("link", { name: title, exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/)
    const id = new URL(page.url()).pathname.split("/").at(-1)!
    const headers = {
      Origin: new URL(baseURL!).origin,
      "X-CSRF-Protection": "1",
    }
    await expect
      .poll(
        async () => {
          const response = await page.request.post("/api/v1/search/keyword", {
            headers,
            data: { query: "lexicalneedle" },
          })
          if (!response.ok()) return false
          const payload = await response.json()
          return payload.data.results.some(
            (r: { documentId: string }) => r.documentId === id
          )
        },
        { timeout: 120000 }
      )
      .toBe(true)
    await page.goto("/search")
    await page
      .getByRole("combobox", { name: "Search query" })
      .fill("lexicalneedle")
    await page.getByRole("button", { name: "Search documents" }).click()
    await expect(
      page.getByRole("link", { name: `${title} (document details, new tab)` })
    ).toBeVisible()
    await expect(page.locator("mark")).toContainText("lexicalneedle")
    await page.getByRole("button", { name: "View page 2 source" }).click()
    await expect(
      page.getByRole("dialog").getByText(/lexicalneedle is on the second page/)
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await page
      .getByRole("combobox", { name: "Search query" })
      .fill("Search workflow")
    await expect(page.getByRole("option")).toContainText(title)
    const other = await foreign.newPage()
    await register(other, `search-b-${run}@example.invalid`, password())
    await other.goto("/search")
    await other
      .getByRole("combobox", { name: "Search query" })
      .fill("lexicalneedle")
    await other.getByRole("button", { name: "Search documents" }).click()
    await expect(other.getByText(/No matching documents/)).toBeVisible()
    expect(
      (
        await page.request.post(`/api/v1/documents/${id}/archive`, { headers })
      ).ok()
    ).toBe(true)
    await page
      .getByRole("combobox", { name: "Search query" })
      .fill("lexicalneedle")
    await page.getByRole("button", { name: "Search documents" }).click()
    await expect(page.getByText(/No matching documents/)).toBeVisible()
  } finally {
    await foreign.close()
  }
})
