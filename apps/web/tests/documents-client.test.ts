import { describe, expect, it, vi } from "vitest"
import { AuthApi, ApiError } from "@/lib/api/client"
import {
  listDocuments,
  listCategories,
  listTags,
  queryString,
} from "@/lib/api/documents"
import { readDocumentQuery } from "@/features/documents/query"
import {
  id,
  profile,
  document,
  tag,
  category,
  envelope,
  json,
} from "./documents.fixture"

describe("document data access", () => {
  it("uses the configured transport, cookies, encoded allowlisted query and safe envelope", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(envelope([document], "opaque_cursor")))
    const api = new AuthApi("https://api.example.invalid/api/v1", fetcher)
    const result = await listDocuments(api, {
      q: "policy & tax",
      archived: "false",
      sort: "createdAt",
      limit: 25,
      categoryId: id,
    })
    const [url, options] = fetcher.mock.calls[0]
    expect(String(url)).toContain(
      "https://api.example.invalid/api/v1/documents?"
    )
    expect(new URL(String(url)).searchParams.get("q")).toBe("policy & tax")
    expect(options).toMatchObject({
      method: "GET",
      credentials: "include",
      cache: "no-store",
    })
    expect(result.meta).toMatchObject({
      nextCursor: "opaque_cursor",
      hasMore: true,
    })
    expect(result.data[0]).not.toHaveProperty("storageKey")
    expect(result.data[0]).not.toHaveProperty("userId")
    expect(result.data[0]).not.toHaveProperty("checksumSha256")
  })
  it("reads paginated real category and tag contracts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(envelope([category])))
      .mockResolvedValueOnce(json(envelope([tag])))
    const api = new AuthApi("/api/v1", fetcher)
    expect((await listCategories(api, id)).data[0].name).toBe("Records")
    expect((await listTags(api, id)).data[0].name).toBe("Finance")
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `/api/v1/categories?limit=100&sort=id&cursor=${id}`,
      `/api/v1/tags?limit=100&sort=id&cursor=${id}`,
    ])
  })
  it("rejects malformed success envelopes and sanitizes errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(
        json({ error: { message: "private SQL", traceId: id } }, 503)
      )
    const api = new AuthApi("/api/v1", fetcher)
    await expect(listDocuments(api, {})).rejects.toMatchObject({ status: 502 })
    await expect(listDocuments(api, {})).rejects.toMatchObject({
      status: 503,
      traceId: id,
    })
    expect(new ApiError(503).message).not.toContain("SQL")
  })
  it("reuses refresh then retries the protected GET once", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ data: { expiresAt: "later" } }))
      .mockResolvedValueOnce(json({ data: profile }))
      .mockResolvedValueOnce(json(envelope([document])))
    expect(
      (await listDocuments(new AuthApi("/api/v1", fetcher), {})).data
    ).toHaveLength(1)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/documents?",
      "/api/v1/auth/me",
      "/api/v1/auth/refresh",
      "/api/v1/auth/me",
      "/api/v1/documents?",
    ])
  })
  it("propagates expired authentication without endless retries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}, 401))
    await expect(
      listDocuments(new AuthApi("/api/v1", fetcher), {})
    ).rejects.toMatchObject({ status: 401 })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
describe("document URL contract", () => {
  it("maps supported values and leaves cursor opaque", () => {
    const query = readDocumentQuery(
      new URLSearchParams(
        `q=+tax+&status=READY&documentType=CUSTOM_TYPE&categoryId=${id}&tagId=${id}&archived=false&sort=createdAt&limit=50&cursor=opaque_cursor&userId=foreign`
      )
    )
    expect(query).toEqual({
      q: "tax",
      status: "READY",
      documentType: "CUSTOM_TYPE",
      categoryId: id,
      tagId: id,
      archived: "false",
      sort: "createdAt",
      limit: 50,
      cursor: "opaque_cursor",
    })
    expect(queryString(query)).not.toContain("userId")
  })
  it("falls back for invalid and unsupported URL values", () => {
    expect(
      readDocumentQuery(
        new URLSearchParams(
          "q=%00&status=HACK&documentType=bad!&categoryId=bad&tagId=bad&archived=yes&sort=password&limit=1000&cursor=../x&userId=other"
        )
      )
    ).toEqual({ sort: "-createdAt", limit: 25 })
  })
})
