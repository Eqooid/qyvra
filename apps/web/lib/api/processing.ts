import { z } from "zod"
import { ApiError, type AuthApi } from "./client"

export const processingStates = [
  "PENDING",
  "QUEUED",
  "PROCESSING",
  "RETRYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const
export const processingStateSchema = z.enum(processingStates)
export const processingProgressSchema = z.object({
  attempt: z.number().int().positive(),
  percent: z.number().int().min(0).max(100),
  stage: z.enum([
    "PREPARING",
    "READING",
    "VERIFYING",
    "FINALIZING",
    "EXTRACTING",
    "CHUNKING",
    "EMBEDDING",
    "INDEXING",
  ]),
  updatedAt: z.string().datetime(),
})
export const processingJobSchema = z.object({
  id: z.string().uuid(),
  jobType: z.string().min(1).max(64),
  status: processingStateSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextRetryAt: z.string().datetime().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  failureCode: z
    .enum([
      "FILE_INTEGRITY_FAILED",
      "STORED_FILE_MISSING",
      "TEMPORARY_PROCESSING_ERROR",
      "PROCESSING_ERROR",
    ])
    .nullable(),
  // Temporary progress is deliberately tolerant: malformed/missing progress
  // cannot make otherwise valid durable status unreadable.
  progress: z
    .unknown()
    .optional()
    .transform((value) => {
      const parsed = processingProgressSchema.safeParse(value)
      return parsed.success ? parsed.data : null
    }),
})
export const processingStatusSchema = z.object({
  aiReadiness: z
    .enum(["READY", "PROCESSING", "FAILED", "UNAVAILABLE", "UNSUPPORTED"])
    .optional(),
  pipeline: z
    .object({
      runId: z.string().uuid(),
      generation: z.number().int().positive(),
      status: z.enum([
        "BUILDING",
        "READY",
        "FAILED",
        "CANCELLED",
        "SUPERSEDED",
      ]),
      currentStage: z.string().nullable(),
      stages: z.array(
        z.object({
          jobType: z.string(),
          status: z.enum([...processingStates, "NOT_SCHEDULED"]),
        })
      ),
    })
    .optional(),
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  jobs: z.array(processingJobSchema),
})
export type ProcessingJob = z.infer<typeof processingJobSchema>
export type ProcessingStatus = z.infer<typeof processingStatusSchema>

export function processingStatusKey(
  owner: string,
  documentId: string,
  versionId: string
) {
  return ["processing-status", owner, documentId, versionId] as const
}

export async function getProcessingStatus(
  api: AuthApi,
  documentId: string,
  versionId: string
) {
  if (
    !z.string().uuid().safeParse(documentId).success ||
    !z.string().uuid().safeParse(versionId).success
  )
    throw new ApiError(404)
  return (
    await api.get(
      `/documents/${documentId}/versions/${versionId}/processing`,
      z.object({ data: processingStatusSchema })
    )
  ).data
}
