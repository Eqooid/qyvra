import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ProcessingStatusContent } from "@/features/documents/processing-status"
import {
  processingLabel,
  shouldPollProcessing,
} from "@/features/documents/processing-presentation"
import type { ProcessingJob, ProcessingStatus } from "@/lib/api/processing"
import { id, secondId } from "./documents.fixture"

const now = "2026-09-30T00:00:00.000Z"
function job(
  status: ProcessingJob["status"],
  overrides: Partial<ProcessingJob> = {}
): ProcessingJob {
  return {
    id,
    jobType: "VERIFY_STORED_FILE",
    status,
    attempts: 1,
    maxAttempts: 3,
    nextRetryAt: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    failureCode: null,
    progress: null,
    ...overrides,
  }
}
function data(jobs: ProcessingJob[]): ProcessingStatus {
  return { documentId: id, documentVersionId: secondId, jobs }
}

describe("processing presentation", () => {
  it("labels AI stages and failures without claiming integrity completion or index readiness", () => {
    render(
      <ProcessingStatusContent
        status={data([
          job("FAILED", {
            jobType: "EXTRACT_TEXT",
            failureCode: "PROCESSING_ERROR",
          }),
          job("COMPLETED", { id: secondId, jobType: "GENERATE_CHUNKS" }),
        ])}
      />
    )
    expect(
      screen.getByText("Document preparation could not be completed.")
    ).toBeInTheDocument()
    expect(screen.getByText("Preparing text complete")).toBeInTheDocument()
    expect(screen.queryByText("Ready for AI search")).not.toBeInTheDocument()
    expect(screen.queryByText("Integrity verified")).not.toBeInTheDocument()
  })
  it("maps durable states to accurate product language and polls only active jobs", () => {
    for (const state of [
      "PENDING",
      "QUEUED",
      "PROCESSING",
      "RETRYING",
    ] as const)
      expect(shouldPollProcessing(data([job(state)]))).toBe(true)
    for (const state of ["COMPLETED", "FAILED", "CANCELLED"] as const)
      expect(shouldPollProcessing(data([job(state)]))).toBe(false)
    expect(shouldPollProcessing(data([]))).toBe(false)
    expect(
      shouldPollProcessing(
        data([job("COMPLETED"), job("PROCESSING", { id: secondId })])
      )
    ).toBe(true)
    expect(processingLabel(job("COMPLETED"))).toBe("Integrity verified")
    expect(processingLabel(job("FAILED"))).toBe("Integrity verification failed")
  })

  it("shows no-processing, waiting, retrying, completion and safe failure text", () => {
    const view = render(<ProcessingStatusContent status={data([])} />)
    expect(
      screen.getByText("No processing information for this version.")
    ).toBeInTheDocument()
    view.rerender(<ProcessingStatusContent status={data([job("QUEUED")])} />)
    expect(
      screen.getByText("Waiting for integrity verification")
    ).toBeInTheDocument()
    view.rerender(
      <ProcessingStatusContent
        status={data([
          job("RETRYING", {
            nextRetryAt: now,
            failureCode: "TEMPORARY_PROCESSING_ERROR",
          }),
        ])}
      />
    )
    expect(
      screen.getByText("Retrying integrity verification")
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Another attempt is scheduled for/)
    ).toBeInTheDocument()
    view.rerender(<ProcessingStatusContent status={data([job("COMPLETED")])} />)
    expect(screen.getByText("Integrity verified")).toBeInTheDocument()
    view.rerender(
      <ProcessingStatusContent
        status={data([
          job("FAILED", {
            failureCode: "FILE_INTEGRITY_FAILED",
          }),
        ])}
      />
    )
    expect(
      screen.getByText("The stored file did not pass integrity verification.")
    ).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })

  it("shows valid progress, treats missing progress normally, and suppresses terminal stale progress", () => {
    const progress = {
      attempt: 1,
      percent: 0,
      stage: "PREPARING" as const,
      updatedAt: now,
    }
    const view = render(
      <ProcessingStatusContent
        status={data([job("PROCESSING", { progress })])}
      />
    )
    expect(screen.getByText("0%")).toBeInTheDocument()
    expect(screen.getByText("Preparing file")).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0"
    )
    view.rerender(
      <ProcessingStatusContent
        status={data([
          job("PROCESSING", {
            progress: { ...progress, percent: 62, stage: "READING" },
          }),
        ])}
      />
    )
    expect(screen.getByText("62%")).toBeInTheDocument()
    expect(screen.getByText("Reading file")).toBeInTheDocument()
    view.rerender(
      <ProcessingStatusContent
        status={data([
          job("PROCESSING", {
            progress: { ...progress, percent: 100, stage: "FINALIZING" },
          }),
        ])}
      />
    )
    expect(screen.getByText("100%")).toBeInTheDocument()
    view.rerender(
      <ProcessingStatusContent
        status={data([job("PROCESSING", { progress: null })])}
      />
    )
    expect(screen.getByText("Verification is in progress.")).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    view.rerender(
      <ProcessingStatusContent status={data([job("FAILED", { progress })])} />
    )
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })
})
