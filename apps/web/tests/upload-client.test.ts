import { beforeEach, describe, expect, it, vi } from "vitest"
import { AuthApi, ApiError, UploadCancelled } from "@/lib/api/client"
import {
  UploadAttempt,
  uploadBody,
  uploadDocument,
  uploadError,
} from "@/lib/api/upload"
import {
  fileError,
  uploadFormSchema,
  uploadLimit,
} from "@/features/documents/upload-validation"
import { id, json, profile } from "./documents.fixture"
import { TestXHR, values } from "./upload.fixture"
beforeEach(() => {
  TestXHR.requests = []
  vi.stubGlobal("XMLHttpRequest", TestXHR)
})
const file = () =>
  new File(["small fixture"], "sample.pdf", { type: "application/pdf" })
describe("upload contract and validation", () => {
  it("builds exactly one file and allowed metadata, omitting empty optional fields", () => {
    const body = uploadBody(file(), {
      ...values,
      title: " Policy ",
      tagIds: [id, id],
    })
    expect([...body.keys()]).toEqual([
      "title",
      "documentType",
      "tagIds",
      "file",
    ])
    expect(body.get("title")).toBe("Policy")
    expect(body.get("tagIds")).toBe(JSON.stringify([id]))
    expect(body.getAll("file")).toHaveLength(1)
  })
  it("reuses keys only for the same selected file and normalized metadata", () => {
    const attempt = new UploadAttempt(),
      selected = file()
    const key = attempt.key(selected, values)
    expect(attempt.key(selected, { ...values, title: " Policy " })).toBe(key)
    expect(attempt.key(selected, { ...values, issuer: "Changed" })).not.toBe(
      key
    )
    const changed = attempt.key(selected, values)
    expect(attempt.key(file(), values)).not.toBe(changed)
    attempt.reset()
    expect(attempt.key(selected, values)).not.toBe(key)
  })
  it.each([
    ["pdf", "application/pdf"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
  ])("accepts %s without reading bytes", (extension, type) => {
    expect(
      fileError(new File(["fixture"], `sample.${extension}`, { type }), 100)
    ).toBeUndefined()
  })
  it("rejects missing, empty, unsupported and oversized files", () => {
    expect(fileError(undefined, 10)).toMatch(/Choose/)
    expect(
      fileError(new File([], "empty.pdf", { type: "application/pdf" }), 10)
    ).toMatch(/empty/)
    expect(
      fileError(new File(["x"], "bad.exe", { type: "application/pdf" }), 10)
    ).toMatch(/Choose/)
    expect(
      fileError(new File(["x"], "bad.pdf", { type: "text/plain" }), 10)
    ).toMatch(/browser/)
    expect(fileError(file(), 1)).toMatch(/exceeds/)
  })
  it("validates size configuration and calendar/date order", () => {
    expect(uploadLimit("")).toBe(52428800)
    expect(uploadLimit("1024")).toBe(1024)
    for (const invalid of ["bad", "0", "-1", "999999999"])
      expect(() => uploadLimit(invalid)).toThrow()
    expect(uploadFormSchema.safeParse({ ...values, title: " " }).success).toBe(
      false
    )
    expect(
      uploadFormSchema.safeParse({ ...values, documentDate: "2026-02-30" })
        .success
    ).toBe(false)
    expect(
      uploadFormSchema.safeParse({
        ...values,
        documentDate: "2026-09-02",
        expirationDate: "2026-09-01",
      }).success
    ).toBe(false)
  })
})
describe("focused multipart transport", () => {
  it("reports network uncertainty without replaying automatically", async () => {
    const pending = uploadDocument(new AuthApi(), file(), values, id, {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })
    TestXHR.requests[0].onerror?.()
    const error = await pending.catch((error) => error)
    expect(error.status).toBe(0)
    expect(uploadError(error)).toMatch(/may have completed/)
    expect(TestXHR.requests).toHaveLength(1)
  })
  it("uses credentials/CSRF/idempotency without setting Content-Type and reports real progress", async () => {
    const progress = vi.fn(),
      signal = new AbortController().signal
    const pending = uploadDocument(
      new AuthApi("https://api.example.invalid/api/v1"),
      file(),
      values,
      id,
      { signal, onProgress: progress }
    )
    const xhr = TestXHR.requests[0]
    expect(xhr.url).toBe("https://api.example.invalid/api/v1/documents")
    expect(xhr.withCredentials).toBe(true)
    expect(xhr.headers).toEqual({
      "Idempotency-Key": id,
      "X-CSRF-Protection": "1",
    })
    xhr.progress(25)
    xhr.progress(2, 0)
    expect(progress.mock.calls).toEqual([[25], [null]])
    xhr.respond()
    expect(await pending).not.toHaveProperty("storageKey")
  })
  it("aborts and makes no rollback claim", async () => {
    const controller = new AbortController()
    const pending = uploadDocument(new AuthApi(), file(), values, id, {
      signal: controller.signal,
      onProgress: vi.fn(),
    })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(UploadCancelled)
    expect(TestXHR.requests[0].abort).toHaveBeenCalledOnce()
    expect(uploadError(new UploadCancelled())).toMatch(/may already/)
  })
  it("reuses the same body/key after established authentication refresh", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ data: { expiresAt: "later" } }))
      .mockResolvedValueOnce(json({ data: profile }))
    const pending = uploadDocument(
      new AuthApi("/api/v1", fetcher),
      file(),
      values,
      id,
      { signal: new AbortController().signal, onProgress: vi.fn() }
    )
    TestXHR.requests[0].respond(401, {})
    await vi.waitFor(() => expect(TestXHR.requests).toHaveLength(2))
    expect(TestXHR.requests[1].body).toBe(TestXHR.requests[0].body)
    expect(TestXHR.requests[1].headers["Idempotency-Key"]).toBe(id)
    TestXHR.requests[1].respond()
    await pending
  })
  it.each([400, 409, 413, 415, 503, 500])(
    "maps HTTP %i without exposing raw details",
    async (status) => {
      const pending = uploadDocument(new AuthApi(), file(), values, id, {
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      })
      TestXHR.requests[0].respond(status, {
        error: { message: "private-path secret", traceId: id },
      })
      const error = await pending.catch((error) => error)
      expect(error).toBeInstanceOf(ApiError)
      expect(error.status).toBe(status)
      expect(uploadError(error)).not.toMatch(/private-path|secret/)
    }
  )
})
