import { test, expect, type Page } from "@playwright/test"
import { randomUUID, createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { png } from "./fixtures"
import { login, register, password } from "./auth"
async function logout(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click()
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
}
async function confirm(page: Page, action: string) {
  await page.getByRole("button", { name: action, exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: `Confirm ${action.toLowerCase()}`,
      exact: true,
    })
    .click()
  await expect(page.getByRole("alertdialog")).toBeHidden()
}
async function download(page: Page, expected: Buffer, filename: string) {
  const event = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download current file" }).click()
  const file = await event
  expect(file.suggestedFilename()).toBe(filename)
  const path = await file.path()
  expect(path).not.toBeNull()
  const bytes = await readFile(path!)
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    createHash("sha256").update(expected).digest("hex")
  )
}
const compose = (action: string) =>
  execFileSync(
    process.execPath,
    [resolve("../../infrastructure/e2e/run.cjs"), action],
    { stdio: "pipe", timeout: 240000 }
  )

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await page.screenshot({
      path: info.outputPath("failure.png"),
      mask: [page.locator('input[type="password"]')],
      fullPage: true,
    })
  }
})

test("Phase 1: account, document workflow, isolation and persistence through Nginx", async ({
  page,
  browser,
}) => {
  test.setTimeout(600000)
  const run = randomUUID(),
    email = `a-${run}@example.invalid`,
    secret = password(),
    nextSecret = password()
  const image = png(Date.now()),
    second = png(Date.now() + 123)
  const categoryName = `Category ${run}`,
    tagName = `Tag ${run}`
  const title = `Document ${run}`
  let documentId = "",
    categoryId = "",
    tagId = ""
  const errors: string[] = []
  page.on("pageerror", () => errors.push("Uncaught browser error"))
  page.on("request", (request) => {
    const host = new URL(request.url()).hostname
    expect(["api", "web", "postgres"]).not.toContain(host)
  })
  const other = await browser.newContext(),
    secondSession = await browser.newContext()
  const b = await other.newPage(),
    a2 = await secondSession.newPage()
  try {
    await test.step("registration, cookie authentication, logout and session persistence", async () => {
      await page.goto("/documents")
      await expect(page).toHaveURL(/\/login$/)
      await register(page, email, secret)
      const cookies = await page.context().cookies()
      expect(
        cookies.filter((cookie) => cookie.httpOnly).length
      ).toBeGreaterThanOrEqual(2)
      await page.reload()
      await expect(
        page.getByRole("button", { name: "Account menu" })
      ).toBeVisible()
      await logout(page)
      await page.goto("/settings")
      await expect(page).toHaveURL(/\/login$/)
      await page.getByLabel("Email address").fill(email)
      await page.getByLabel("Password", { exact: true }).fill(password())
      await page.getByRole("button", { name: "Log in", exact: true }).click()
      await expect(
        page.getByText("Email or password is incorrect. Please try again.")
      ).toBeVisible()
      await login(page, email, secret)
    })
    await test.step("profile update and password change preserve current session and revoke another", async () => {
      await login(a2, email, secret)
      await page.getByRole("button", { name: "Account menu" }).click()
      await page.getByRole("menuitem", { name: "Account settings" }).click()
      await page.getByLabel("Display name").fill("E2E Owner")
      await page.getByLabel("Timezone", { exact: true }).fill("Asia/Bangkok")
      await page.getByLabel("Locale", { exact: true }).fill("en-US")
      await page.getByRole("button", { name: "Save profile" }).click()
      await expect(page.getByText("Profile saved.")).toBeVisible()
      await page.reload()
      await expect(page.getByLabel("Display name")).toHaveValue("E2E Owner")
      await page.getByLabel("Current password", { exact: true }).fill(secret)
      await page.getByLabel("New password", { exact: true }).fill(nextSecret)
      await page.getByLabel("Confirm new password").fill(nextSecret)
      await page
        .getByRole("button", { name: "Change password", exact: true })
        .click()
      await expect(page.getByText(/Password changed\./)).toBeVisible()
      await expect(
        page.getByLabel("Current password", { exact: true })
      ).toHaveValue("")
      expect(
        (
          await secondSession.request.get("http://localhost:18080/api/v1/me")
        ).status()
      ).toBe(401)
      await a2.reload()
      await expect(a2).toHaveURL(/\/login$/)
      await a2.getByLabel("Email address").fill(email)
      await a2.getByLabel("Password", { exact: true }).fill(secret)
      await a2.getByRole("button", { name: "Log in", exact: true }).click()
      await expect(
        a2.getByText("Email or password is incorrect. Please try again.")
      ).toBeVisible()
      await login(a2, email, nextSecret)
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        await expect(
          page.getByRole("heading", { name: "Account settings" })
        ).toBeVisible()
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth
          )
        ).toBe(true)
        for (const mode of ["Dark", "Light"]) {
          await page.getByRole("button", { name: "Change theme" }).click()
          await page
            .getByRole("menuitemradio", { name: mode, exact: true })
            .click()
          await expect(page.locator("html")).toHaveClass(
            new RegExp(mode.toLowerCase())
          )
          await expect(page.getByLabel("Display name")).toBeVisible()
        }
      }
    })
    await test.step("category and tag create, rename and cancelled deletion", async () => {
      for (const [kind, noun, name] of [
        ["categories", "category", categoryName],
        ["tags", "tag", tagName],
      ] as const) {
        await page.goto(`/${kind}`)
        await page
          .getByRole("button", { name: `Create ${noun}`, exact: true })
          .click()
        await page.getByRole("dialog").getByLabel("Name *").fill("Original")
        await page
          .getByRole("dialog")
          .getByRole("button", { name: `Create ${noun}`, exact: true })
          .click()
        await page
          .getByRole("button", {
            name: `${noun === "category" ? "Edit" : "Rename"} Original`,
            exact: true,
          })
          .click()
        await page.getByRole("dialog").getByLabel("Name *").fill(name)
        const response = page.waitForResponse(
          (r) =>
            r.url().includes(`/api/v1/${kind}/`) &&
            r.request().method() === "PATCH"
        )
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Save changes" })
          .click()
        const body = await (await response).json()
        if (noun === "category") categoryId = body.data.id
        else tagId = body.data.id
        await page.getByRole("button", { name: "Delete", exact: true }).click()
        await page
          .getByRole("alertdialog")
          .getByRole("button", { name: "Cancel", exact: true })
          .click()
        await expect(page.getByText(name, { exact: true })).toBeVisible()
      }
    })
    await test.step("upload validation, file removal and pre-submission cancellation", async () => {
      await page.goto("/documents/upload")
      await page
        .getByRole("button", { name: "Upload document", exact: true })
        .click()
      await expect(page.getByText("Enter a title.")).toBeVisible()
      await page.getByLabel("File *", { exact: true }).setInputFiles({
        name: "invalid.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("invalid"),
      })
      await expect(
        page.getByText("Choose a PDF, JPEG or PNG file.")
      ).toBeVisible()
      await page.getByLabel("File *", { exact: true }).setInputFiles({
        name: "too-large.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(2097153),
      })
      await expect(page.getByText(/File exceeds/)).toBeVisible()
      await page.getByLabel("File *", { exact: true }).setInputFiles({
        name: "first.png",
        mimeType: "image/png",
        buffer: image,
      })
      await page.getByRole("button", { name: "Remove file" }).click()
      await expect(page.getByText("Choose one file.")).toBeVisible()
      await page.getByLabel("Title *", { exact: true }).fill("Cancelled draft")
      await page.goto("/documents")
      await expect(
        page.getByText("Cancelled draft", { exact: true })
      ).toHaveCount(0)
      await page.goto("/documents/upload")
      await expect(page.getByLabel("Title *", { exact: true })).toHaveValue("")
    })
    await test.step("real upload with category and tags; secure download byte verification", async () => {
      await page.getByLabel("File *", { exact: true }).setInputFiles({
        name: "first.png",
        mimeType: "image/png",
        buffer: image,
      })
      await page.getByLabel("Title *", { exact: true }).fill(title)
      await page.getByLabel("Document type *", { exact: true }).fill("OTHER")
      await page.getByLabel("Category (optional)").click()
      await page
        .getByRole("option", { name: categoryName, exact: true })
        .click()
      await page.getByLabel("Tags (optional)").click()
      await page.getByRole("option", { name: tagName, exact: true }).click()
      await page.keyboard.press("Escape")
      await page
        .getByRole("button", { name: "Upload document", exact: true })
        .click()
      await expect(page).toHaveURL(/\/documents$/)
      await page.getByRole("link", { name: title, exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/)
      documentId = new URL(page.url()).pathname.split("/").pop()!
      await expect(
        page.getByRole("heading", { name: title, exact: true })
      ).toBeVisible()
      await expect(page.getByText(categoryName, { exact: true })).toBeVisible()
      await download(page, image, "first.png")
      expect(await page.locator("body").innerText()).not.toMatch(
        /storageKey|\/data\/brainless/
      )
    })
    await test.step("metadata editing and version history retain immutable files", async () => {
      await page.getByRole("button", { name: "Edit metadata" }).click()
      await page.getByLabel("Issuer (optional)").fill("Changed issuer")
      await page.getByRole("button", { name: "Save changes" }).click()
      await expect(
        page.getByRole("heading", { name: "Edit metadata" })
      ).toBeHidden()
      await page.reload()
      await expect(
        page.getByText("Changed issuer", { exact: true })
      ).toBeVisible()
      await page
        .getByRole("link", { name: "Version history", exact: true })
        .click()
      await page
        .getByRole("button", { name: "Inspect version 1", exact: true })
        .click()
      await expect(
        page.getByRole("region", { name: "Version 1 metadata" })
      ).toContainText("image/png")
      await page
        .getByRole("button", { name: "Upload new version", exact: true })
        .click()
      await page.getByLabel("New version file *").setInputFiles({
        name: "second.png",
        mimeType: "image/png",
        buffer: second,
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
        page.getByRole("button", { name: "Inspect version 2", exact: true })
      ).toBeVisible()
      await expect(
        page.getByText("Current / latest", { exact: true })
      ).toHaveCount(1)
      await expect(
        page.getByText("first.png", { exact: true }).first()
      ).toBeVisible()
      await page.goto(`/documents/${documentId}`)
      await download(page, second, "second.png")
    })
    await test.step("another user cannot list, read or mutate owned resources", async () => {
      await register(b, `b-${run}@example.invalid`, password())
      await b.goto("/documents")
      await expect(b.getByText(title, { exact: true })).toHaveCount(0)
      await b.goto(`/documents/${documentId}`)
      await expect(b.getByText(/Document not found/)).toBeVisible()
      const api = other.request,
        base = "http://localhost:18080/api/v1"
      const headers = {
        Origin: "http://localhost:18080",
        "X-CSRF-Protection": "1",
      }
      for (const path of [
        `documents/${documentId}`,
        `documents/${documentId}/download`,
        `documents/${documentId}/versions`,
      ]) {
        const result = await api.get(`${base}/${path}`)
        expect(result.status()).toBe(404)
        expect(await result.text()).not.toContain(title)
      }
      for (const [method, path, data] of [
        ["PATCH", `documents/${documentId}`, { title: "Attack" }],
        ["POST", `documents/${documentId}/archive`, undefined],
        ["POST", `documents/${documentId}/restore`, undefined],
        ["DELETE", `documents/${documentId}`, undefined],
        ["PATCH", `categories/${categoryId}`, { name: "Attack" }],
        ["DELETE", `categories/${categoryId}`, undefined],
        ["PATCH", `tags/${tagId}`, { name: "Attack" }],
        ["DELETE", `tags/${tagId}`, undefined],
      ] as const)
        expect(
          (
            await api.fetch(`${base}/${path}`, { method, headers, data })
          ).status()
        ).toBe(404)
      expect(
        (
          await api.post(`${base}/documents/${documentId}/versions`, {
            headers: { ...headers, "Idempotency-Key": randomUUID() },
            multipart: {
              file: {
                name: "attack.png",
                mimeType: "image/png",
                buffer: second,
              },
            },
          })
        ).status()
      ).toBe(404)
      await page.reload()
      await expect(page.getByRole("heading", { name: title })).toBeVisible()
    })
    await test.step("database and file persistence across API/web recreation", async () => {
      compose("recreate")
      await page.reload()
      await expect(page.getByRole("heading", { name: title })).toBeVisible()
      await download(page, second, "second.png")
    })
    await test.step("archive, restore, cancelled delete and recoverable soft deletion", async () => {
      await page.goto("/categories")
      await page.getByRole("button", { name: "Delete", exact: true }).click()
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Confirm delete" })
        .click()
      await expect(
        page.getByText(/This category is still assigned/)
      ).toBeVisible()
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Cancel" })
        .click()
      await page.goto("/tags")
      await confirm(page, "Delete")
      await page.goto(`/documents/${documentId}`)
      await expect(page.getByRole("heading", { name: title })).toBeVisible()
      await expect(page.getByText(tagName, { exact: true })).toHaveCount(0)
      await page.getByRole("button", { name: "Archive", exact: true }).click()
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Cancel" })
        .click()
      await expect(
        page.getByRole("button", { name: "Archive", exact: true })
      ).toBeVisible()
      await confirm(page, "Archive")
      await expect(
        page.getByRole("button", { name: "Restore", exact: true })
      ).toBeVisible()
      await confirm(page, "Restore")
      await page.getByRole("button", { name: "Delete", exact: true }).click()
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Cancel" })
        .click()
      // Clear the category before deletion; backend blocks deleting assigned categories.
      await page.getByRole("button", { name: "Edit metadata" }).click()
      await page.getByLabel("Category (optional)").selectOption("")
      await page.getByRole("button", { name: "Save changes" }).click()
      await expect(
        page.getByRole("heading", { name: "Edit metadata" })
      ).toBeHidden()
      await confirm(page, "Delete")
      await expect(page).toHaveURL(/\/documents(?:\?.*)?$/)
      expect(
        (await page.request.get(`/api/v1/documents/${documentId}`)).status()
      ).toBe(404)
      await page.goto("/categories")
      await confirm(page, "Delete")
    })
    await test.step("logout-all invalidates both A sessions but leaves B authenticated", async () => {
      await page.goto("/settings")
      await confirm(page, "Log out of all sessions")
      await expect(page).toHaveURL(/\/login$/)
      expect((await page.request.get("/api/v1/me")).status()).toBe(401)
      expect(
        (
          await secondSession.request.get("http://localhost:18080/api/v1/me")
        ).status()
      ).toBe(401)
      await a2.goto("/documents")
      await expect(a2).toHaveURL(/\/login$/)
      expect(
        (await other.request.get("http://localhost:18080/api/v1/me")).status()
      ).toBe(200)
    })
    expect(errors).toEqual([])
  } finally {
    await other.close()
    await secondSession.close()
  }
})

test("real access and refresh expiry redirects protected UI", async ({
  page,
}) => {
  compose("expiry")
  try {
    const email = `expiry-${randomUUID()}@example.invalid`,
      secret = password()
    await register(page, email, secret)
    expect((await page.request.get("/api/v1/me")).status()).toBe(200)
    await expect
      .poll(async () => (await page.request.get("/api/v1/me")).status(), {
        timeout: 20000,
        intervals: [1000],
      })
      .toBe(401)
    await page.goto("/settings")
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByLabel("Current password")).toHaveCount(0)
    await login(page, email, secret)
  } finally {
    compose("recreate")
  }
})
