import { describe, expect, it, vi } from "vitest"
import { AuthApi } from "@/lib/api/client"
import {
  getProcessingStatus,
  processingStatusKey,
  processingStatusSchema,
} from "@/lib/api/processing"
import { id, secondId, json } from "./documents.fixture"

const now = "2026-09-30T00:00:00.000Z"
const job = {
  id,
  jobType: "VERIFY_STORED_FILE",
  status: "PROCESSING",
  attempts: 1,
  maxAttempts: 3,
  nextRetryAt: null,
  startedAt: now,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
  failureCode: null,
  progress: { attempt: 1, percent: 62, stage: "READING", updatedAt: now },
}

describe("owned processing client", () => {
  it("uses the version-specific API route and strips infrastructure fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        data: {
          documentId: id,
          documentVersionId: secondId,
          jobs: [{ ...job, outboxId: "private", queue: "private" }],
        },
      })
    )
    const api = new AuthApi("/api/v1", fetcher)
    const value = await getProcessingStatus(api, id, secondId)
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/v1/documents/${id}/versions/${secondId}/processing`
    )
    expect(value.jobs[0].progress).toMatchObject({ percent: 62 })
    expect(value.jobs[0]).not.toHaveProperty("outboxId")
    expect(value.jobs[0]).not.toHaveProperty("queue")
    expect(processingStatusKey(id, id, secondId)).not.toEqual(
      processingStatusKey(id, id, id)
    )
    await expect(
      getProcessingStatus(api, id, "../unsafe")
    ).rejects.toMatchObject({
      status: 404,
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("accepts absent progress and discards malformed temporary progress", () => {
    const base = { documentId: id, documentVersionId: secondId }
    expect(
      processingStatusSchema.parse({
        ...base,
        jobs: [{ ...job, progress: undefined }],
      }).jobs[0].progress
    ).toBeNull()
    for (const percent of [-1, 101, "62"])
      expect(
        processingStatusSchema.parse({
          ...base,
          jobs: [{ ...job, progress: { ...job.progress, percent } }],
        }).jobs[0].progress
      ).toBeNull()
    for (const percent of [0, 62, 100])
      expect(
        processingStatusSchema.parse({
          ...base,
          jobs: [{ ...job, progress: { ...job.progress, percent } }],
        }).jobs[0].progress?.percent
      ).toBe(percent)
  })
})
