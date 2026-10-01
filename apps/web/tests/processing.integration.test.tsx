import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"
import { AuthProvider } from "@/features/auth/provider"
import { ProcessingStatusSection } from "@/features/documents/processing-status"
import { id, secondId, json } from "./documents.fixture"
import { processingPollIntervalMs } from "@/features/documents/processing-presentation"

const now = "2026-09-30T00:00:00.000Z"
function response(versionId: string, status: "PROCESSING" | "COMPLETED") {
  return json({
    data: {
      documentId: id,
      documentVersionId: versionId,
      jobs: [
        {
          id: versionId,
          jobType: "VERIFY_STORED_FILE",
          status,
          attempts: 1,
          maxAttempts: 3,
          nextRetryAt: null,
          startedAt: now,
          completedAt: status === "COMPLETED" ? now : null,
          createdAt: now,
          updatedAt: now,
          failureCode: null,
          progress:
            status === "PROCESSING"
              ? null
              : { attempt: 1, percent: 95, stage: "READING", updatedAt: now },
        },
      ],
    },
  })
}

beforeEach(() => vi.restoreAllMocks())

it("loads each visible version through its own owned endpoint without borrowing status", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    return response(
      url.includes(`/versions/${secondId}/`) ? secondId : id,
      url.includes(`/versions/${secondId}/`) ? "PROCESSING" : "COMPLETED"
    )
  })
  vi.stubGlobal("fetch", fetcher)
  render(
    <AuthProvider>
      <ProcessingStatusSection
        owner={id}
        documentId={id}
        versionId={secondId}
      />
      <ProcessingStatusSection owner={id} documentId={id} versionId={id} />
    </AuthProvider>
  )
  const regions = await screen.findAllByRole("region", {
    name: "File processing",
  })
  expect(
    await within(regions[0]).findByText("Verifying stored file")
  ).toBeInTheDocument()
  expect(
    await within(regions[1]).findByText("Integrity verified")
  ).toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(
    expect.arrayContaining([
      `/api/v1/documents/${id}/versions/${secondId}/processing`,
      `/api/v1/documents/${id}/versions/${id}/processing`,
    ])
  )
})

it("keeps retrieval errors separate from job failure and recovers on retry", async () => {
  let failed = true
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () =>
      failed
        ? json({ error: { message: "/private/path" } }, 503)
        : response(secondId, "COMPLETED")
    )
  )
  render(
    <AuthProvider>
      <ProcessingStatusSection
        owner={id}
        documentId={id}
        versionId={secondId}
      />
    </AuthProvider>
  )
  const alert = await screen.findByRole("alert")
  expect(alert).toHaveTextContent("Could not refresh processing status.")
  expect(alert).not.toHaveTextContent("/private/path")
  expect(
    screen.queryByText("Integrity verification failed")
  ).not.toBeInTheDocument()
  failed = false
  await userEvent.click(screen.getByRole("button", { name: "Retry status" }))
  await waitFor(() =>
    expect(screen.getByText("Integrity verified")).toBeInTheDocument()
  )
})

it("polls an active job and stops after the durable state becomes terminal", async () => {
  let calls = 0
  const intervals = vi.spyOn(globalThis, "setInterval")
  const cleared = vi.spyOn(globalThis, "clearInterval")
  const fetcher = vi.fn<typeof fetch>(async () =>
    response(secondId, ++calls === 1 ? "PROCESSING" : "COMPLETED")
  )
  vi.stubGlobal("fetch", fetcher)
  render(
    <AuthProvider>
      <ProcessingStatusSection
        owner={id}
        documentId={id}
        versionId={secondId}
      />
    </AuthProvider>
  )
  expect(await screen.findByText("Verifying stored file")).toBeInTheDocument()
  const timer = intervals.mock.calls.find(
    ([, delay]) => delay === processingPollIntervalMs
  )
  expect(timer).toBeDefined()
  await act(async () => {
    ;(timer?.[0] as () => void)()
  })
  expect(await screen.findByText("Integrity verified")).toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(cleared).toHaveBeenCalled()
})
