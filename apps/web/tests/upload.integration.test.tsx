import { chooseDate } from "./date-picker"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { AuthProvider } from "@/features/auth/provider"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { UploadForm } from "@/features/documents/upload-form"
import { DocumentsList } from "@/features/documents/documents-list"
import { category, envelope, id, json, profile, tag } from "./documents.fixture"
import { TestXHR } from "./upload.fixture"
const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  path: "/documents/upload",
}))
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  usePathname: () => navigation.path,
  useSearchParams: () => new URLSearchParams(),
}))
beforeEach(() => {
  TestXHR.requests = []
  navigation.push.mockReset()
  navigation.replace.mockReset()
  navigation.path = "/documents/upload"
  vi.stubGlobal("XMLHttpRequest", TestXHR)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input.includes("/auth/me")
        ? json({ data: profile })
        : json(
            envelope(
              input.includes("/categories")
                ? [category]
                : input.includes("/tags")
                  ? [tag]
                  : []
            )
          )
    )
  )
})
let invalidate: ReturnType<typeof vi.spyOn>
function ObserveCache() {
  const cache = useQueryClient()
  useEffect(() => {
    invalidate = vi.spyOn(cache, "invalidateQueries")
  }, [cache])
  return null
}
const tree = (list = false) => (
  <AuthProvider>
    <ObserveCache />
    <DashboardShell>
      {list ? <DocumentsList /> : <UploadForm maxBytes={100} />}
    </DashboardShell>
  </AuthProvider>
)
async function fill() {
  const user = userEvent.setup({ applyAccept: false })
  await user.type(await screen.findByLabelText("Title *"), "Policy")
  await user.upload(
    screen.getByLabelText("File *"),
    new File(["fixture"], "policy.pdf", { type: "application/pdf" })
  )
  return user
}
describe("upload form through real API adapter", () => {
  it("retries an interrupted upload with the same key and changes it after file replacement", async () => {
    render(tree())
    const user = await fill()
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(1))
    const key = TestXHR.requests[0].headers["Idempotency-Key"]
    await act(async () => TestXHR.requests[0].onerror?.())
    expect(await screen.findByText(/Network interrupted/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(2))
    expect(TestXHR.requests[1].headers["Idempotency-Key"]).toBe(key)
    await act(async () => TestXHR.requests[1].onerror?.())
    await user.upload(
      screen.getByLabelText("File *"),
      new File(["new"], "new.png", { type: "image/png" })
    )
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(3))
    expect(TestXHR.requests[2].headers["Idempotency-Key"]).not.toBe(key)
  })
  it.each([
    ["pdf", "application/pdf"],
    ["jpg", "image/jpeg"],
    ["png", "image/png"],
  ])("submits a supported %s file", async (extension, type) => {
    render(tree())
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("Title *"), "Test document")
    await user.upload(
      screen.getByLabelText("File *"),
      new File(["small fixture"], `sample.${extension}`, { type })
    )
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(1))
    expect((TestXHR.requests[0].body?.get("file") as File).type).toBe(type)
    await act(async () => TestXHR.requests[0].respond())
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/documents")
    )
  })
  it("keeps optional lookup failures separate from upload and labels empty tags", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("/auth/me")
          ? json({ data: profile })
          : input.includes("/categories")
            ? json({}, 503)
            : json(envelope([]))
      )
    )
    render(tree())
    const user = await fill()
    expect(
      await screen.findByText(/Categories unavailable/)
    ).toBeInTheDocument()
    expect(screen.getByText("No tags available.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(1))
    expect(TestXHR.requests[0].body?.has("categoryId")).toBe(false)
  })
  it("submits the optional description from the upload form", async () => {
    render(tree())
    const user = await fill()
    await user.type(
      screen.getByLabelText("Description (optional)"),
      "Quarterly financial report"
    )
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(1))
    expect(TestXHR.requests[0].body?.get("description")).toBe(
      "Quarterly financial report"
    )
  })
  it("warns before leaving an active upload and aborts when unmounted", async () => {
    const view = render(tree())
    const user = await fill()
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(1))
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    view.unmount()
    expect(TestXHR.requests[0].abort).toHaveBeenCalledOnce()
  })
  it("protects the route with existing authentication", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({}, 401))
    )
    render(tree())
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/login")
    )
    expect(screen.queryByLabelText("File *")).not.toBeInTheDocument()
  })
  it("validates required fields and dates before sending", async () => {
    render(tree())
    await userEvent.click(
      await screen.findByRole("button", { name: "Upload document" })
    )
    expect(await screen.findByText("Enter a title.")).toBeInTheDocument()
    expect(screen.getByText("Choose one file.")).toBeInTheDocument()
    const user = await fill()
    await chooseDate("Document date (optional)", "2026-09-02")
    await chooseDate("Expiration date (optional)", "2026-09-01")
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    expect(
      await screen.findByText(
        "Expiration cannot be earlier than the document date."
      )
    ).toBeInTheDocument()
    expect(TestXHR.requests).toHaveLength(0)
  })
  it.each([
    ["bad.exe", "text/plain", "x", /Choose a PDF/],
    ["empty.png", "image/png", "", /file is empty/],
    ["big.pdf", "application/pdf", "x".repeat(101), /exceeds/],
  ])(
    "rejects %s and supports replacement/removal",
    async (name, type, content, message) => {
      render(tree())
      const user = userEvent.setup({ applyAccept: false })
      await user.upload(
        await screen.findByLabelText("File *"),
        new File([content], name, { type })
      )
      expect(await screen.findByText(message)).toBeInTheDocument()
      await user.upload(
        screen.getByLabelText("File *"),
        new File(["ok"], "image.png", { type: "image/png" })
      )
      expect(screen.queryByText(message)).not.toBeInTheDocument()
      expect(screen.getByText("image.png")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Remove file" }))
      expect(screen.queryByText("image.png")).not.toBeInTheDocument()
    }
  )
  it("rejects multiple dropped files", async () => {
    render(tree())
    const input = await screen.findByLabelText("File *")
    fireEvent.drop(input.parentElement!, {
      dataTransfer: {
        files: [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")],
      },
    })
    expect(
      await screen.findByText("Choose exactly one file.")
    ).toBeInTheDocument()
  })
  it("submits selected IDs, prevents duplicates, reports progress and navigates with success", async () => {
    const view = render(tree())
    const user = await fill()
    await user.click(
      screen.getByRole("combobox", { name: "Category (optional)" })
    )
    await user.click(await screen.findByRole("option", { name: "Records" }))
    await user.click(screen.getByRole("combobox", { name: "Tags (optional)" }))
    await user.click(await screen.findByRole("option", { name: "Finance" }))
    await user.keyboard("{Escape}")
    await user.dblClick(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(1))
    const xhr = TestXHR.requests[0]
    expect(xhr.body?.get("categoryId")).toBe(id)
    expect(xhr.body?.get("tagIds")).toBe(JSON.stringify([id]))
    act(() => xhr.progress(50))
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50"
    )
    act(() => xhr.progress(100))
    expect(
      screen.getByText(/Waiting for server validation/)
    ).toBeInTheDocument()
    await act(async () => xhr.respond())
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/documents")
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["documents", id] })
    navigation.path = "/documents"
    view.rerender(tree(true))
    expect(
      await screen.findByText(/Document uploaded. Status: UPLOADED/)
    ).toBeInTheDocument()
    expect(screen.queryByText("private-path")).not.toBeInTheDocument()
  })
  it("cancels, preserves metadata and reuses the unchanged attempt key", async () => {
    render(tree())
    const user = await fill()
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(1))
    const first = TestXHR.requests[0]
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow")
    await user.click(screen.getByRole("button", { name: "Cancel upload" }))
    expect(
      await screen.findByText(/server may already have completed/)
    ).toBeInTheDocument()
    expect(first.abort).toHaveBeenCalledOnce()
    expect(screen.getByLabelText("Title *")).toHaveValue("Policy")
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(2))
    expect(TestXHR.requests[1].headers["Idempotency-Key"]).toBe(
      first.headers["Idempotency-Key"]
    )
    await act(async () => TestXHR.requests[1].respond(503, {}))
    await user.type(screen.getByLabelText("Title *"), " changed")
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(3))
    expect(TestXHR.requests[2].headers["Idempotency-Key"]).not.toBe(
      first.headers["Idempotency-Key"]
    )
  })
  it.each([
    [400, /Upload rejected/],
    [409, /file may already exist/],
    [503, /services are unavailable/],
  ])("shows safe error %i and keeps the form", async (status, message) => {
    render(tree())
    const user = await fill()
    await user.click(screen.getByRole("button", { name: "Upload document" }))
    await waitFor(() => expect(TestXHR.requests).toHaveLength(1))
    await act(async () =>
      TestXHR.requests[0].respond(status, {
        error: { message: "private-path" },
      })
    )
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByLabelText("Title *")).toHaveValue("Policy")
    expect(screen.queryByText("private-path")).not.toBeInTheDocument()
  })
})
