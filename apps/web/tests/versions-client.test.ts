import { beforeEach, expect, it, vi } from "vitest"
import { AuthApi, ApiError } from "@/lib/api/client"
import { listVersions, getVersion, uploadVersion } from "@/lib/api/versions"
import { id, secondId, json, envelope } from "./documents.fixture"
import { version, versionReceipt } from "./versions.fixture"
import { TestXHR } from "./upload.fixture"
beforeEach(() => {
  TestXHR.requests = []
  vi.stubGlobal("XMLHttpRequest", TestXHR)
})
it("uses bounded descending pagination, credentials and safe envelopes", async () => {
  const fetcher = vi.fn().mockResolvedValue(json(envelope([version])))
  const result = await listVersions(
    new AuthApi("/api/v1", fetcher),
    id,
    secondId
  )
  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/documents/${id}/versions?limit=25&sort=-versionNumber&cursor=${secondId}`,
    expect.objectContaining({ credentials: "include" })
  )
  expect(result.data[0]).not.toHaveProperty("storageKey")
  expect(result.data[0]).not.toHaveProperty("checksumSha256")
})
it("reads individual metadata and rejects malformed routes", async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ data: version }))
  expect(
    (await getVersion(new AuthApi("/api/v1", fetcher), id, secondId))
      .versionNumber
  ).toBe(2)
  expect(fetcher.mock.calls[0][0]).toBe(
    `/api/v1/documents/${id}/versions/${secondId}`
  )
  await expect(
    getVersion(new AuthApi(), "../private", id)
  ).rejects.toBeInstanceOf(ApiError)
})
it("uploads exactly one file to the documented route with cookies, CSRF and idempotency", async () => {
  const progress = vi.fn()
  const pending = uploadVersion(
    new AuthApi(),
    id,
    new File(["fixture"], "new.png", { type: "image/png" }),
    secondId,
    { signal: new AbortController().signal, onProgress: progress }
  )
  const xhr = TestXHR.requests[0]
  expect(xhr.url).toBe(`/api/v1/documents/${id}/versions`)
  expect(xhr.withCredentials).toBe(true)
  expect([...xhr.body!.keys()]).toEqual(["file"])
  expect(xhr.headers).toEqual({
    "X-CSRF-Protection": "1",
    "Idempotency-Key": secondId,
  })
  xhr.progress(40)
  expect(progress).toHaveBeenCalledWith(40)
  xhr.respond(201, { data: versionReceipt })
  expect((await pending).version).not.toHaveProperty("storageKey")
})
