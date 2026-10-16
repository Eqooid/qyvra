import { test, expect, type Page } from "@playwright/test"
import {
  searchId,
  searchResponse,
  lexicalSource,
} from "../tests/search.fixture"

async function mockApi(page: Page) {
  let authenticated = true
  const requests: { path: string; body: Record<string, unknown> }[] = []
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    const body = route.request().postDataJSON() as Record<
      string,
      unknown
    > | null
    requests.push({ path, body: body ?? {} })
    let data: unknown = {}
    let status = 200
    if (path.endsWith("/auth/me")) {
      if (!authenticated) status = 401
      data = {
        id: searchId,
        email: "owner@example.invalid",
        displayName: null,
        locale: "en",
        timezone: "UTC",
      }
    } else if (path.endsWith("/auth/logout")) {
      authenticated = false
      data = { loggedOut: true }
    } else if (path.endsWith("/search/suggestions"))
      data = {
        suggestions: [
          {
            text: "Private report",
            type: "title",
            documentId: searchId,
            documentVersionId: searchId,
          },
        ],
      }
    else if (path.endsWith("/search/hybrid")) status = 503
    else if (path.endsWith("/search/keyword"))
      data = body?.cursor
        ? {
            ...searchResponse,
            results: [],
            pagination: searchResponse.pagination,
          }
        : {
            ...searchResponse,
            pagination: {
              ...searchResponse.pagination,
              nextCursor: "opaque",
              hasMore: true,
            },
          }
    else if (path.includes("/extractions/")) data = lexicalSource
    else if (path.endsWith("/categories") || path.endsWith("/tags")) {
      await route.fulfill({
        json: {
          data: [
            {
              id: searchId,
              name: "Finance",
              createdAt: "2026-10-15",
              updatedAt: "2026-10-15",
              color: null,
              icon: null,
            },
          ],
          meta: { requestId: searchId, hasMore: false, nextCursor: null },
        },
      })
      return
    }
    await route.fulfill({ status, json: { data } })
  })
  return {
    requests,
    setAuthenticated: (value: boolean) => {
      authenticated = value
    },
  }
}
test("mock API: keyboard autocomplete, safe Unicode highlights, exact sources, filters, paging, explicit fallback and logout", async ({
  page,
}) => {
  const { requests } = await mockApi(page)
  const errors: string[] = []
  page.on("pageerror", () => errors.push("Uncaught browser error"))
  await page.goto("/search")
  const input = page.getByRole("combobox", { name: "Search query" })
  await input.fill("pri")
  await expect(page.getByRole("option")).toContainText("Private report")
  await input.press("ArrowDown")
  await input.press("Enter")
  await expect(input).toHaveValue("Private report")
  await page.getByRole("button", { name: "Search documents" }).click()
  await expect(page.locator("mark")).toHaveText("private")
  await expect(page.locator("article script")).toHaveCount(0)
  await page.getByRole("button", { name: "View page 2 source" }).click()
  await expect(page.getByText("Exact page two")).toBeVisible()
  await expect(page.getByText("Version 2 · Page 2 · Part 1")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("button", { name: "View page 2 source" })
  ).toBeFocused()
  await expect(input).toHaveValue("Private report")
  await page.getByRole("button", { name: "Next page", exact: true }).click()
  await expect(page.getByText(/No matching documents/)).toBeVisible()
  expect(
    requests.filter((r) => r.path.endsWith("/search/keyword"))[1].body.cursor
  ).toBe("opaque")
  await page.getByRole("button", { name: "Filters", exact: true }).click()
  await page.getByLabel("Filename contains").fill("report")
  await page.getByRole("button", { name: "Apply filters" }).click()
  await expect(page.getByText("Active filters: filename")).toBeVisible()
  await page.getByRole("combobox", { name: "Search mode" }).click()
  await page.getByRole("option", { name: "Hybrid", exact: true }).click()
  await page.getByRole("button", { name: "Search documents" }).click()
  await expect(
    page.getByRole("region", { name: "Search results" }).getByRole("alert")
  ).toContainText("unavailable")
  await page.getByRole("button", { name: "Use Keyword mode" }).click()
  await expect(
    page.getByRole("combobox", { name: "Search mode" })
  ).toContainText("Keyword")
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click()
  await page.getByRole("button", { name: "Reset filters" }).click()
  await expect(page.getByText("Active filters: filename")).toHaveCount(0)
  expect(new URL(page.url()).search).toBe("")
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([])
  await page.getByRole("button", { name: "Account menu" }).click()
  await page.getByRole("menuitem", { name: /Log out/i }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByText("Private report", { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})
for (const scheme of ["light", "dark"] as const)
  test(`mock API: mobile ${scheme} keyboard and layout`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: scheme })
    await mockApi(page)
    await page.goto("/search")
    const input = page.getByRole("combobox", { name: "Search query" })
    await input.fill("private")
    await input.press("Escape")
    await input.press("Enter")
    await expect(page.locator("mark")).toHaveText("private")
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
    await page.getByRole("button", { name: "Open navigation" }).click()
    await page.getByRole("link", { name: "Search", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Close navigation" })
    ).toHaveCount(0)
  })

test("mock API: browser back restores only private form state and account changes clear it", async ({
  page,
}) => {
  const { setAuthenticated } = await mockApi(page)
  await page.goto("/search")
  const input = page.getByRole("combobox", { name: "Search query" })
  await input.fill("private remembered query")
  await page.getByRole("link", { name: "AI Search", exact: true }).click()
  await expect(page).toHaveURL(/\/ai$/)
  await page.goBack()
  await expect(input).toHaveValue("private remembered query")
  await expect(page.getByText("Private report", { exact: true })).toHaveCount(0)
  setAuthenticated(false)
  await page.evaluate(() => {
    const channel = new BroadcastChannel("document-tracker-auth")
    channel.postMessage("logout")
    channel.close()
  })
  await expect(page).toHaveURL(/\/login$/)
  setAuthenticated(true)
  await page.goto("/search")
  await expect(input).toHaveValue("")
})

test("mock API: hybrid semantic evidence has no fabricated lexical marks and reuses exact chunk navigation", async ({
  page,
}) => {
  await mockApi(page)
  await page.route("**/api/v1/search/hybrid", async (route) =>
    route.fulfill({
      json: {
        data: {
          ...searchResponse,
          mode: "hybrid",
          results: [
            {
              ...searchResponse.results[0],
              ranking: "document-rrf60-v1",
              matches: [
                {
                  kind: "chunk",
                  snippet: "Semantic-only evidence",
                  chunkId: searchId,
                  chunkSetId: searchId,
                  indexManifestId: searchId,
                  embeddingProfileId: searchId,
                  startOffset: 0,
                  endOffset: 22,
                },
              ],
            },
          ],
        },
      },
    })
  )
  await page.route("**/api/v1/documents/*/versions/*/chunks/*", async (route) =>
    route.fulfill({
      json: {
        data: {
          documentId: searchId,
          documentVersionId: searchId,
          chunkId: searchId,
          chunkOrdinal: 0,
          title: "Private report",
          versionNumber: 2,
          originalFilename: "report.pdf",
          pageSpans: [{ pageNumber: 2, startOffset: 0, endOffset: 18 }],
          excerptStart: 0,
          excerptEnd: 18,
          excerptHash: "a".repeat(64),
          excerpt: "Canonical semantic",
        },
      },
    })
  )
  await page.goto("/search")
  await page.getByRole("combobox", { name: "Search mode" }).click()
  await page.getByRole("option", { name: "Hybrid", exact: true }).click()
  await page.getByRole("combobox", { name: "Search query" }).fill("private")
  await page.getByRole("button", { name: "Search documents" }).click()
  await expect(page.getByText("Semantic-only evidence")).toBeVisible()
  await expect(page.locator("article")).toHaveCount(1)
  await expect(page.locator("mark")).toHaveCount(0)
  await page.getByRole("button", { name: "View source", exact: true }).click()
  await expect(page.getByText("Canonical semantic")).toBeVisible()
})
