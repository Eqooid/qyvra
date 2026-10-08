import { test, expect, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { register, password } from "./auth"

test.skip(
  process.env.E2E_AI_ENABLED !== "true",
  "Use infrastructure/e2e/ai-run.cjs for the real isolated AI stack"
)
test("T11: anonymous AI and exact-source routes require a session", async ({
  page,
}) => {
  await page.goto("/ai")
  await expect(page).toHaveURL(/\/login$/)
  const id = "13ee39cf-ed80-4d42-a7ec-a5df28c297d9"
  await page.goto(`/documents/${id}/versions/${id}/sources/${id}`)
  await expect(page).toHaveURL(/\/login$/)
  expect(
    (
      await page.request.get(
        `/api/v1/documents/${id}/versions/${id}/chunks/${id}`
      )
    ).status()
  ).toBe(401)
  await expect(
    page.getByRole("heading", { name: "Document source", exact: true })
  ).toHaveCount(0)
})
test("T11: real upload-to-RAG, exact sources, two-user isolation, readiness, insufficient evidence, themes and mobile keyboard navigation", async ({
  page,
  browser,
}) => {
  test.setTimeout(240000)
  const run = randomUUID(),
    errors: string[] = []
  page.on("pageerror", () => errors.push("Uncaught browser error"))
  const foreign = await browser.newContext()
  try {
    const b = await foreign.newPage()
    await register(page, `ai-a-${run}@example.invalid`, password())
    await register(b, `ai-b-${run}@example.invalid`, password())
    async function upload(p: Page, title: string, fixture: string) {
      await p.goto("/documents/upload")
      await p.getByLabel("Title *", { exact: true }).fill(title)
      await p.getByLabel("File *", { exact: true }).setInputFiles({
        name: `${fixture}.pdf`,
        mimeType: "application/pdf",
        buffer: await readFile(
          resolve("../api/test/fixtures/pdf", `${fixture}.pdf`)
        ),
      })
      await p
        .getByRole("button", { name: "Upload document", exact: true })
        .click()
      await expect(p).toHaveURL(/\/documents$/)
      await p.getByRole("link", { name: title, exact: true }).click()
      await expect(p).toHaveURL(/\/documents\/[0-9a-f-]{36}$/)
      const documentId = new URL(p.url()).pathname.split("/").at(-1)!
      const detailResponse = await p.request.get(
        `/api/v1/documents/${documentId}`
      )
      expect(detailResponse.status()).toBe(200)
      const detail = await detailResponse.json()
      const versionId = detail.data.currentVersion.id as string
      await expect
        .poll(
          async () =>
            (
              await (
                await p.request.get(
                  `/api/v1/documents/${documentId}/versions/${versionId}/processing`
                )
              ).json()
            ).data.aiReadiness,
          { timeout: 90000 }
        )
        .toBe("READY")
      await expect(
        p.getByText("Ready for AI search", { exact: true })
      ).toBeVisible({ timeout: 15000 })
      return { documentId, versionId }
    }
    const aDoc = await upload(page, `A owned ${run}`, "single")
    const bDoc = await upload(b, `B private ${run}`, "script")
    const bUser = (await (await b.request.get("/api/v1/auth/me")).json()).data
      .id as string
    // Prove the excluded user's vector scores higher globally, using internal test-only inspection.
    const proof = execFileSync(
      "docker",
      [
        "exec",
        `${process.env.E2E_PROJECT_NAME || "qyvra-e2e-ai"}-api-1`,
        "node",
        "-e",
        `const {createPrismaClient}=require('@qyvra/database');const {vectorCollectionName}=require('./dist/modules/ai/vector-store');const db=createPrismaClient({url:'postgresql://'+encodeURIComponent(process.env.POSTGRES_USER)+':'+encodeURIComponent(process.env.POSTGRES_PASSWORD)+'@postgres:5432/'+process.env.POSTGRES_DB});(async()=>{const p=await db.aiServingProfile.findUnique({where:{id:1}});const r=await fetch('http://qdrant:6333/collections/'+vectorCollectionName(p.embeddingProfileId)+'/points/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:[1,2,3],limit:1,with_payload:true,filter:{must:[{key:"documentId",match:{any:["${aDoc.documentId}","${bDoc.documentId}"]}}]}})});const j=await r.json();console.log(j.result.points[0].payload.userId==='${bUser}');})().finally(()=>db.$disconnect());`,
      ],
      { encoding: "utf8", windowsHide: true }
    )
    expect(proof.trim()).toBe("true")

    await page.goto("/ai")
    await page.getByLabel("Search query").fill("find relevant")
    await page
      .getByRole("button", { name: "Search documents", exact: true })
      .click()
    await expect(
      page.getByRole("heading", { name: `A owned ${run}`, exact: true })
    ).toBeVisible()
    await expect(
      page.getByText(`B private ${run}`, { exact: true })
    ).toHaveCount(0)
    const source = page.getByRole("link", { name: "View source" }).first()
    const sourcePath = (await source.getAttribute("href"))!
    expect(sourcePath).toContain(`/versions/${aDoc.versionId}/sources/`)
    await source.click()
    await expect(
      page.getByRole("region", { name: "Source excerpt" })
    ).toContainText("Hello")
    await expect(page.getByText("Version 1 · Page 1")).toBeVisible()
    const chunkId = sourcePath.split("/").at(-1)!
    const backendSource = `/api/v1/documents/${aDoc.documentId}/versions/${aDoc.versionId}/chunks/${chunkId}`
    expect((await b.request.get(backendSource)).status()).toBe(404)
    await b.goto(sourcePath)
    await expect(
      b.getByRole("alert").filter({ hasText: "no longer have access" })
    ).toBeVisible()
    await expect(b.getByText("Hello", { exact: false })).toHaveCount(0)

    await page.getByRole("link", { name: "Back to AI Search" }).click()
    await page
      .getByRole("button", { name: "Ask documents", exact: true })
      .click()
    await page.getByLabel("Question").fill("What text appears?")
    await page
      .getByRole("button", { name: "Ask documents", exact: true })
      .last()
      .click()
    await expect(
      page.getByRole("heading", { name: "Grounded answer" })
    ).toBeVisible()
    await expect(
      page.getByText(`B private ${run}`, { exact: false })
    ).toHaveCount(0)
    const citation = page
      .getByRole("button", { name: "Source S1", exact: true })
      .first()
    await citation.focus()
    await page.keyboard.press("Enter")
    const sheet = page.getByRole("dialog")
    await expect(sheet).toContainText(`A owned ${run}`)
    await expect(sheet).toContainText("Version 1 · Page 1")
    await expect(
      sheet.getByRole("link", { name: "Open source" })
    ).toHaveAttribute("href", sourcePath)
    await page.keyboard.press("Escape")
    await expect(sheet).toHaveCount(0)
    await expect(citation).toBeFocused()

    // The same state remains readable with the existing theme system and at narrow width.
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        localStorage.setItem("theme", value)
        document.documentElement.classList.toggle("dark", value === "dark")
      }, theme)
      await page.setViewportSize({ width: 375, height: 812 })
      await expect
        .poll(
          () =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth
            ),
          { message: `AI page fits mobile viewport in ${theme}` }
        )
        .toBe(true)
      await citation.click()
      await expect(page.getByRole("dialog")).toContainText("Hello")
      await expect
        .poll(
          () =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth
            ),
          { message: `Citation Sheet fits mobile viewport in ${theme}` }
        )
        .toBe(true)
      await page.keyboard.press("Tab")
      await expect
        .poll(
          () =>
            page.evaluate(
              () => !!document.activeElement?.closest('[role="dialog"]')
            ),
          { message: "Keyboard focus remains inside the Sheet" }
        )
        .toBe(true)
      await page.keyboard.press("Escape")
    }
    await page.getByLabel("Question").fill("unrelated")
    await page
      .getByRole("button", { name: "Ask documents", exact: true })
      .last()
      .click()
    await expect(
      page.getByRole("heading", { name: "Insufficient evidence" })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Grounded answer" })
    ).toHaveCount(0)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/documents/${aDoc.documentId}`)
    await page
      .getByRole("button", { name: "Reprocess for AI", exact: true })
      .click()
    await expect(page.getByRole("alertdialog")).toContainText("paid providers")
    await page.getByRole("button", { name: "Confirm reprocess for ai" }).click()
    await expect(page.getByText(/Document preparation scheduled/)).toBeVisible()
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(
                `/api/v1/documents/${aDoc.documentId}/versions/${aDoc.versionId}/processing`
              )
            ).json()
          ).data.pipeline.status,
        { timeout: 90000 }
      )
      .toBe("READY")
    // Exact original provenance survives reprocessing and a new current version.
    await page
      .getByRole("link", { name: "Version history", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Upload new version", exact: true })
      .click()
    await page.getByLabel("New version file *").setInputFiles({
      name: "new.pdf",
      mimeType: "application/pdf",
      buffer: await readFile(resolve("../api/test/fixtures/pdf/multi.pdf")),
    })
    await page
      .getByRole("button", { name: "Upload new version", exact: true })
      .last()
      .click()
    await page
      .getByRole("button", { name: "Confirm upload new version" })
      .click()
    await expect(
      page.getByRole("button", { name: "Inspect version 2" })
    ).toBeVisible()
    await page.goto(sourcePath)
    await expect(page.getByText("Version 1 · Page 1")).toBeVisible()
    await expect(
      page.getByRole("region", { name: "Source excerpt" })
    ).toContainText("Hello")
    await page.request.post(`/api/v1/documents/${aDoc.documentId}/archive`, {
      headers: { "X-CSRF-Protection": "1" },
      data: {},
    })
    await page.reload()
    await expect(
      page.getByRole("alert").filter({ hasText: "no longer have access" })
    ).toBeVisible()
    await expect(
      page.getByRole("region", { name: "Source excerpt" })
    ).toHaveCount(0)
    expect(bDoc.documentId).not.toBe(aDoc.documentId)
    expect(errors).toEqual([])
  } finally {
    await foreign.close()
  }
})
