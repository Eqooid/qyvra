import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"
import { AuthProvider } from "@/features/auth/provider"
import { AiWorkspace, AnswerText } from "@/features/ai/ai-page"
import {
  CitationSheet,
  CitationSourcePage,
} from "@/features/ai/source-components"
import { AiDocumentStatus } from "@/features/documents/ai-document-status"
import { citation, answer } from "./ai.fixture"
import { id, json } from "./documents.fixture"
vi.mock("next/navigation", () => ({
  usePathname: () => "/ai",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}))
beforeEach(() => vi.restoreAllMocks())
const profile = {
  id,
  email: "owner@example.invalid",
  displayName: null,
  locale: "en",
  timezone: "UTC",
}

it("makes repeated and nonsequential validated markers accessible while rendering HTML/URLs/unknown markers literally", async () => {
  const open = vi.fn()
  const view = render(
    <AnswerText
      text="<img src=x onerror=alert(1)> https://evil.invalid [S4] [S4] [S999]"
      citations={[citation]}
      open={open}
    />
  )
  expect(screen.getAllByRole("button", { name: "Source S4" })).toHaveLength(2)
  expect(view.container.querySelector("img")).toBeNull()
  expect(screen.queryByRole("link")).not.toBeInTheDocument()
  expect(view.container.textContent).toContain("[S999]")
  await userEvent.click(screen.getAllByRole("button")[1])
  expect(open.mock.calls[0][0]).toEqual(citation)
})
it("submits search explicitly, validates empty input, replaces results and shows insufficient evidence normally", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    json({
      data: String(input).endsWith("answers")
        ? {
            outcome: "insufficient_evidence",
            answer: null,
            requestId: id,
            citations: [],
            reason: "no_authorized_evidence",
          }
        : { results: [] },
    })
  )
  vi.stubGlobal("fetch", fetcher)
  render(
    <AuthProvider>
      <AiWorkspace owner={id} />
    </AuthProvider>
  )
  await userEvent.click(
    screen.getByRole("button", { name: "Search documents" })
  )
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter a question")
  expect(fetcher).not.toHaveBeenCalled()
  await userEvent.type(screen.getByLabelText("Search query"), "hello")
  expect(fetcher).not.toHaveBeenCalled()
  await userEvent.click(
    screen.getByRole("button", { name: "Search documents" })
  )
  expect(await screen.findByText(/No relevant text/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "Ask documents" }))
  expect(screen.queryByText(/No relevant text/)).not.toBeInTheDocument()
  await userEvent.type(screen.getByLabelText("Question"), "unknown")
  await userEvent.click(
    screen.getAllByRole("button", { name: "Ask documents" }).at(-1)!
  )
  expect(await screen.findByText("Insufficient evidence")).toBeInTheDocument()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})
it("guards duplicate submits and ignores responses after cancellation or mode changes", async () => {
  let finish!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal("fetch", fetcher)
  render(
    <AuthProvider>
      <AiWorkspace owner={id} />
    </AuthProvider>
  )
  await userEvent.type(screen.getByLabelText("Search query"), "hello")
  await userEvent.dblClick(
    screen.getByRole("button", { name: "Search documents" })
  )
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(
    screen.getByRole("status", { name: "Searching documents" })
  ).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "Cancel request" }))
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  finish(json({ data: { results: [] } }))
  await waitFor(() =>
    expect(screen.queryByText(/No relevant text/)).not.toBeInTheDocument()
  )
})
it("reauthorizes citations in the Sheet, preserves exact-version navigation, and fails closed on revoked access", async () => {
  let denied = false
  const fetcher = vi.fn<typeof fetch>(async () =>
    denied
      ? json({ error: { message: "sensitive backend detail" } }, 404)
      : json({ data: citation })
  )
  vi.stubGlobal("fetch", fetcher)
  const trigger = document.createElement("button"),
    close = vi.fn()
  const view = render(
    <AuthProvider>
      <CitationSheet
        citation={citation}
        trigger={trigger}
        close={close}
        owner={id}
      />
    </AuthProvider>
  )
  expect(await screen.findByText(citation.excerpt)).toBeInTheDocument()
  expect(screen.getByText("Version 2 · Pages 2, 3")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
    "href",
    expect.stringContaining(
      `/versions/${citation.documentVersionId}/sources/${citation.chunkId}`
    )
  )
  view.unmount()
  denied = true
  render(
    <AuthProvider>
      <CitationSheet
        citation={citation}
        trigger={trigger}
        close={close}
        owner={id}
      />
    </AuthProvider>
  )
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no longer have access"
  )
  expect(screen.queryByText(citation.excerpt)).not.toBeInTheDocument()
  expect(
    screen.queryByRole("link", { name: "Open source" })
  ).not.toBeInTheDocument()
})
it("shows canonical metadata on an owned source route and no content for a foreign route", async () => {
  let denied = false
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) =>
      json(
        String(input).endsWith("/auth/me")
          ? { data: profile }
          : denied
            ? { error: {} }
            : { data: citation },
        !String(input).endsWith("/auth/me") && denied ? 404 : 200
      )
    )
  )
  const props = {
    documentId: citation.documentId,
    versionId: citation.documentVersionId,
    chunkId: citation.chunkId,
  }
  const view = render(
    <AuthProvider>
      <CitationSourcePage {...props} />
    </AuthProvider>
  )
  expect(await screen.findByText(citation.excerpt)).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "Version history" })).toHaveAttribute(
    "href",
    `/documents/${citation.documentId}/versions`
  )
  view.unmount()
  denied = true
  render(
    <AuthProvider>
      <CitationSourcePage {...props} />
    </AuthProvider>
  )
  expect(await screen.findByRole("alert")).toHaveTextContent("unavailable")
  expect(screen.queryByText(citation.excerpt)).not.toBeInTheDocument()
})
it("uses authoritative readiness rather than READY pipeline labels and requires cost confirmation before idempotent reprocessing", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    json({
      data: String(input).endsWith("reprocess")
        ? { runId: id, generation: 2, status: "BUILDING" }
        : {
            documentId: id,
            documentVersionId: citation.documentVersionId,
            jobs: [],
            aiReadiness: "UNAVAILABLE",
            pipeline: {
              runId: citation.chunkId,
              generation: 1,
              status: "READY",
              currentStage: null,
              stages: [],
            },
          },
    })
  )
  vi.stubGlobal("fetch", fetcher)
  render(
    <AuthProvider>
      <AiDocumentStatus
        owner={id}
        documentId={id}
        versionId={citation.documentVersionId}
        archived={false}
      />
    </AuthProvider>
  )
  expect(
    await screen.findByText("Not available for AI search")
  ).toBeInTheDocument()
  expect(screen.queryByText("Ready for AI search")).not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole("button", { name: "Reprocess for AI" })
  )
  expect(screen.getByRole("alertdialog")).toHaveTextContent("paid providers")
  expect(
    fetcher.mock.calls.some(([url]) => String(url).endsWith("reprocess"))
  ).toBe(false)
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm reprocess for ai" })
  )
  expect(
    await screen.findByText(/Document preparation scheduled/)
  ).toBeInTheDocument()
  const call = fetcher.mock.calls.find(([url]) =>
    String(url).endsWith("reprocess")
  )
  expect(call?.[1]?.headers).toMatchObject({
    "X-CSRF-Protection": "1",
    "Idempotency-Key": expect.any(String),
  })
  expect(
    screen.getByRole("button", { name: "Reprocess for AI" })
  ).toBeDisabled()
})
it("renders validated answers, sanitizes provider errors and replaces previous answers", async () => {
  let failure = false
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () =>
      failure
        ? json({ error: { message: "api-key-private" } }, 503)
        : json({ data: answer })
    )
  )
  render(
    <AuthProvider>
      <AiWorkspace owner={id} />
    </AuthProvider>
  )
  await userEvent.click(screen.getByRole("button", { name: "Ask documents" }))
  await userEvent.type(screen.getByLabelText("Question"), "hello")
  await userEvent.click(
    screen.getAllByRole("button", { name: "Ask documents" }).at(-1)!
  )
  expect(await screen.findByText("Grounded answer")).toBeInTheDocument()
  failure = true
  await userEvent.click(
    screen.getAllByRole("button", { name: "Ask documents" }).at(-1)!
  )
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "currently unavailable"
  )
  expect(screen.queryByText("Grounded answer")).not.toBeInTheDocument()
  expect(screen.queryByText("api-key-private")).not.toBeInTheDocument()
})
