import { describe, expect, it, vi } from "vitest"
import { AuthApi } from "@/lib/api/client"
import {
  getDocument,
  updateDocument,
  changeDocumentState,
  prepareDocumentDownload,
} from "@/lib/api/documents"
import { metadataPatch, editDefaults } from "@/features/documents/edit-metadata"
import { uploadFormSchema } from "@/features/documents/upload-validation"
import { detail } from "./detail.fixture"
import { id, json, profile } from "./documents.fixture"
describe("document detail data access", () => {
  it("parses safe detail and rejects invalid IDs without a request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ data: detail }))
    const api = new AuthApi("/api/v1", fetcher)
    const value = await getDocument(api, id)
    expect(value.verifiedSummary).toBe(detail.verifiedSummary)
    expect(value.description).toBeNull()
    expect(value.currentVersion).toEqual(detail.currentVersion)
    expect(value).not.toHaveProperty("storageKey")
    await expect(getDocument(api, "../other")).rejects.toMatchObject({
      status: 404,
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("sends changed metadata only and uses null/empty array for clears", () => {
    const values = editDefaults(detail)
    expect(metadataPatch(detail, values)).toEqual({})
    expect(
      metadataPatch(detail, {
        ...values,
        title: " Updated ",
        issuer: "",
        categoryId: "",
        tagIds: [],
      })
    ).toEqual({ title: "Updated", issuer: null, categoryId: null, tagIds: [] })
    expect(metadataPatch(detail, { ...values, tagIds: [id, id] })).toEqual({})
    expect(
      metadataPatch(detail, { ...values, description: " Owner notes " })
    ).toEqual({ description: "Owner notes" })
    expect(
      metadataPatch(
        { ...detail, description: "Existing" },
        { ...values, description: "" }
      )
    ).toEqual({ description: null })
    expect(
      metadataPatch(
        { ...detail, description: "Existing" },
        { ...values, description: undefined }
      )
    ).toEqual({})
  })
  it("validates owner description length and control characters", () => {
    const values = editDefaults(detail)
    expect(
      uploadFormSchema.safeParse({ ...values, description: "Useful notes" })
        .success
    ).toBe(true)
    expect(
      uploadFormSchema.safeParse({ ...values, description: "x".repeat(2001) })
        .success
    ).toBe(false)
    expect(
      uploadFormSchema.safeParse({ ...values, description: "line\u0000break" })
        .success
    ).toBe(false)
  })
  it("allowlists PATCH fields, uses credentials and CSRF, and preserves omission", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ data: detail }))
    const wider = {
      issuer: null,
      tagIds: [id, id],
      userId: "foreign",
      status: "READY",
      storageKey: "private",
    }
    await updateDocument(new AuthApi("/api/v1", fetcher), id, wider)
    expect(fetcher.mock.calls[0]).toEqual([
      `/api/v1/documents/${id}`,
      expect.objectContaining({
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Protection": "1",
        },
        body: JSON.stringify({ issuer: null, tagIds: [id] }),
      }),
    ])
  })
  it("PATCH distinguishes omitted, updated, and cleared descriptions", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: detail }))
      .mockResolvedValueOnce(
        json({ data: { ...detail, description: "Updated" } })
      )
      .mockResolvedValueOnce(json({ data: { ...detail, description: null } }))
    const api = new AuthApi("/api/v1", fetcher)
    await updateDocument(api, id, { title: "Other", description: undefined })
    const updated = await updateDocument(api, id, { description: "Updated" })
    const cleared = await updateDocument(api, id, { description: null })
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      title: "Other",
    })
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      description: "Updated",
    })
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      description: null,
    })
    expect(updated.currentVersion).toEqual(detail.currentVersion)
    expect(cleared.currentVersion).toEqual(detail.currentVersion)
    expect(cleared.description).toBeNull()
  })
  it.each(["archive", "restore", "delete"] as const)(
    "uses the authorized %s endpoint",
    async (action) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ data: detail }))
      await changeDocumentState(new AuthApi("/api/v1", fetcher), id, action)
      expect(fetcher.mock.calls[0]).toEqual([
        `/api/v1/documents/${id}${action === "delete" ? "" : `/${action}`}`,
        expect.objectContaining({
          method: action === "delete" ? "DELETE" : "POST",
          credentials: "include",
          headers: { "X-CSRF-Protection": "1" },
        }),
      ])
    }
  )
  it("refreshes a rejected mutation once with its original body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ data: { expiresAt: "later" } }))
      .mockResolvedValueOnce(json({ data: profile }))
      .mockResolvedValueOnce(json({ data: detail }))
    await updateDocument(new AuthApi("/api/v1", fetcher), id, {
      title: "Updated",
    })
    expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[4][1]?.body)
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/auth/refresh")
      )
    ).toHaveLength(1)
  })
  it("cancels the download probe without reading bytes or creating a Blob", async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({ cancel })
    const response = new Response(stream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "attachment; filename=test.pdf",
      },
    })
    const blob = vi.spyOn(response, "blob"),
      buffer = vi.spyOn(response, "arrayBuffer")
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    const url = await prepareDocumentDownload(
      new AuthApi("https://api.example.invalid/api/v1", fetcher),
      id
    )
    expect(url).toBe(
      `https://api.example.invalid/api/v1/documents/${id}/download`
    )
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: "include",
      cache: "no-store",
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(blob).not.toHaveBeenCalled()
    expect(buffer).not.toHaveBeenCalled()
    expect(url).not.toContain("private")
  })
  it.each([404, 409, 503])(
    "maps download %i before browser navigation",
    async (status) => {
      await expect(
        prepareDocumentDownload(
          new AuthApi(
            "/api/v1",
            vi
              .fn<typeof fetch>()
              .mockResolvedValue(
                json({ error: { message: "private path" } }, status)
              )
          ),
          id
        )
      ).rejects.toMatchObject({ status })
    }
  )
})
