import type { ProcessingJob, ProcessingStatus } from "@/lib/api/processing"

export const processingPollIntervalMs = 5000

export function shouldPollProcessing(status?: ProcessingStatus): boolean {
  return (
    status?.pipeline?.status === "BUILDING" ||
    !!status?.jobs.some((job) =>
      ["PENDING", "QUEUED", "PROCESSING", "RETRYING"].includes(job.status)
    )
  )
}

export function processingLabel(job: ProcessingJob): string {
  const stages: Record<string, string> = {
    EXTRACT_TEXT: "Extracting text",
    GENERATE_CHUNKS: "Preparing text",
    GENERATE_EMBEDDINGS: "Preparing search data",
    INDEX_VECTORS: "Indexing search data",
    REMOVE_VECTORS: "Removing search data",
  }
  if (stages[job.jobType])
    return job.status === "COMPLETED"
      ? `${stages[job.jobType]} complete`
      : job.status === "FAILED"
        ? "AI processing failed"
        : job.status === "CANCELLED"
          ? "AI processing cancelled"
          : job.status === "RETRYING"
            ? "Retrying AI processing"
            : stages[job.jobType]
  if (job.jobType === "VERIFY_STORED_FILE") {
    switch (job.status) {
      case "PENDING":
      case "QUEUED":
        return "Waiting for integrity verification"
      case "PROCESSING":
        return "Verifying stored file"
      case "RETRYING":
        return "Retrying integrity verification"
      case "COMPLETED":
        return "Integrity verified"
      case "FAILED":
        return "Integrity verification failed"
      case "CANCELLED":
        return "Integrity verification cancelled"
    }
  }
  switch (job.status) {
    case "PENDING":
    case "QUEUED":
      return "Waiting for processing"
    case "PROCESSING":
      return "Processing"
    case "RETRYING":
      return "Retrying processing"
    case "COMPLETED":
      return "Processing complete"
    case "FAILED":
      return "Processing failed"
    case "CANCELLED":
      return "Processing cancelled"
  }
}

export function processingStageLabel(
  stage: NonNullable<ProcessingJob["progress"]>["stage"]
): string {
  switch (stage) {
    case "PREPARING":
      return "Preparing file"
    case "READING":
      return "Reading file"
    case "VERIFYING":
      return "Checking integrity"
    case "FINALIZING":
      return "Finishing verification"
    case "EXTRACTING":
      return "Extracting text"
    case "CHUNKING":
      return "Preparing text"
    case "EMBEDDING":
      return "Preparing search data"
    case "INDEXING":
      return "Indexing search data"
  }
}

export function processingFailureLabel(
  code: ProcessingJob["failureCode"],
  jobType = "VERIFY_STORED_FILE"
): string | null {
  if (jobType !== "VERIFY_STORED_FILE") {
    if (code === "PROCESSING_ERROR")
      return "Document preparation could not be completed."
    if (code === "TEMPORARY_PROCESSING_ERROR")
      return "A temporary issue interrupted document preparation."
  }
  switch (code) {
    case "FILE_INTEGRITY_FAILED":
      return "The stored file did not pass integrity verification."
    case "STORED_FILE_MISSING":
      return "The stored file could not be found."
    case "TEMPORARY_PROCESSING_ERROR":
      return "A temporary issue interrupted verification."
    case "PROCESSING_ERROR":
      return "Verification could not be completed."
    case null:
      return null
  }
}
