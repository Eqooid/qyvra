import { chooseDate } from "./date-picker"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { AuthProvider } from "@/features/auth/provider"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { DocumentDetailPage } from "@/features/documents/document-detail"
import { DocumentsList } from "@/features/documents/documents-list"
import type { DocumentDetail } from "@/lib/api/documents"
import { detail } from "./detail.fixture"
import {
  category,
  tag,
  profile,
  json,
  envelope,
  id,
  secondId,
} from "./documents.fixture"
const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  usePathname: () => "/documents/detail",
  useSearchParams: () => new URLSearchParams(),
}))
let current: DocumentDetail = { ...detail }
let invalidation: ReturnType<typeof vi.spyOn>
function Observe() {
  const cache = useQueryClient()
  useEffect(() => {
    invalidation = vi.spyOn(cache, "invalidateQueries")
  }, [cache])
  return null
}
const tree = (list = false) => (
  <AuthProvider>
    <Observe />
    <DashboardShell>
      {list ? <DocumentsList /> : <DocumentDetailPage documentId={id} />}
    </DashboardShell>
  </AuthProvider>
)
function mockApi(
  override?: (
    url: string,
    options?: RequestInit
  ) => Response | Promise<Response> | undefined
) {
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = String(input),
      overridden = override?.(url, options)
    if (overridden) return overridden
    if (url.endsWith("/auth/me")) return json({ data: profile })
    if (url.endsWith("/processing"))
      return json({
        data: {
          documentId: id,
          documentVersionId: current.currentVersion?.id,
          jobs: [],
        },
      })
    if (url.includes("/categories"))
      return json(
        envelope([
          category,
          { ...category, id: secondId, name: "Other category" },
        ])
      )
    if (url.includes("/tags"))
      return json(envelope([tag, { ...tag, id: secondId, name: "Other tag" }]))
    if (url.endsWith("/archive"))
      current = { ...current, status: "ARCHIVED", isArchived: true }
    if (url.endsWith("/restore"))
      current = { ...current, status: "UPLOADED", isArchived: false }
    if (options?.method === "DELETE")
      current = { ...current, deletedAt: "2026-09-17T00:00:00.000Z" }
    if (options?.method === "PATCH") {
      const patch = JSON.parse(String(options.body))
      current = {
        ...current,
        ...patch,
        category: patch.categoryId === null ? null : current.category,
        tags: patch.tagIds?.length === 0 ? [] : current.tags,
      }
    }
    if (url.includes("/documents?")) return json(envelope([]))
    return json({ data: current })
  })
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}
beforeEach(() => {
  current = { ...detail }
  navigation.push.mockReset()
  navigation.replace.mockReset()
})
describe("document detail actions through real client", () => {
  it("prevents duplicate metadata submission while saving", async () => {
    let complete!: (value: Response) => void
    const fetcher = mockApi((_url, options) =>
      options?.method === "PATCH"
        ? new Promise((resolve) => {
            complete = resolve
          })
        : undefined
    )
    render(tree())
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole("button", { name: "Edit metadata" })
    )
    await user.type(
      screen.getByLabelText("Description (optional)"),
      "New description"
    )
    await user.dblClick(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([, options]) => options?.method === "PATCH")
      ).toHaveLength(1)
    )
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
    expect(screen.getByLabelText("Description (optional)")).toBeDisabled()
    await act(async () => complete(json({}, 503)))
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
  })
  it("explains unavailable storage without rendering provider errors", async () => {
    mockApi((url) =>
      url.endsWith("/download")
        ? json({ error: { message: "private provider path" } }, 503)
        : undefined
    )
    render(tree())
    await userEvent.click(
      await screen.findByRole("button", { name: "Download current file" })
    )
    expect(
      await screen.findByText(
        "The current file is unavailable. Please try again later."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText("private provider path")).not.toBeInTheDocument()
  })
  it("protects the detail route", async () => {
    mockApi(() => json({}, 401))
    render(tree())
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/login")
    )
    expect(screen.queryByText(detail.title)).not.toBeInTheDocument()
  })
  it("shows loading until the authenticated detail resolves", async () => {
    mockApi((url) =>
      url.endsWith(`/documents/${id}`) ? new Promise(() => {}) : undefined
    )
    render(tree())
    expect(await screen.findByText("Loading document…")).toHaveAttribute(
      "role",
      "status"
    )
  })
  it("renders safe metadata and the owned current-version summary", async () => {
    mockApi()
    render(tree())
    expect(
      await screen.findByRole("heading", { name: detail.title })
    ).toBeInTheDocument()
    expect(screen.getByText(detail.verifiedSummary)).toBeInTheDocument()
    expect(screen.getByText("Records")).toBeInTheDocument()
    expect(screen.getByText("Finance")).toBeInTheDocument()
    expect(screen.getByText("No description")).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: "Current version" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(detail.currentVersion.originalFilename)
    ).toBeInTheDocument()
    expect(screen.getByText("v2")).toBeInTheDocument()
    expect(screen.getByText("PDF")).toBeInTheDocument()
    expect(screen.getByText("1.0 KiB")).toBeInTheDocument()
    expect(screen.getByText(/2026.*UTC/)).toBeInTheDocument()
    expect(screen.queryByText("private-storage-key")).not.toBeInTheDocument()
    expect(screen.queryByText("private-owner")).not.toBeInTheDocument()
    expect(screen.queryByText("private-checksum")).not.toBeInTheDocument()
    expect(screen.queryByText("Current file")).not.toBeInTheDocument()
  })
  it("shows the complete description and safely handles a metadata-only document", async () => {
    current = {
      ...detail,
      description: "First line\nSecond line",
      currentVersion: null,
    }
    mockApi()
    render(tree())
    expect(await screen.findByText("First line Second line")).toHaveClass(
      "whitespace-pre-wrap"
    )
    expect(
      screen.getByText("No current version available.")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Download current file" })
    ).toBeDisabled()
    expect(
      screen.getByRole("link", { name: "Version history" })
    ).toHaveAttribute("href", `/documents/${id}/versions`)
  })
  it.each([
    [404, "Document not found"],
    [503, "Unable to load document"],
  ])("shows a safe %i state", async (status, title) => {
    mockApi((url) =>
      url.endsWith(`/documents/${id}`) ? json({}, status) : undefined
    )
    render(tree())
    expect(
      await screen.findByRole("heading", { name: title })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Back to documents" })
    ).toHaveAttribute("href", "/documents")
  })
  it("initializes edit, validates metadata and saves changed fields with explicit clears", async () => {
    const fetcher = mockApi()
    render(tree())
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole("button", { name: "Edit metadata" })
    )
    expect(screen.getByLabelText("Title *")).toHaveValue(detail.title)
    expect(screen.getByLabelText("Issuer (optional)")).toHaveValue(
      detail.issuer
    )
    await user.clear(screen.getByLabelText("Title *"))
    await user.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByText("Enter a title.")).toBeInTheDocument()
    await user.type(screen.getByLabelText("Title *"), "Updated policy")
    await user.clear(screen.getByLabelText("Issuer (optional)"))
    await user.selectOptions(screen.getByLabelText("Category (optional)"), "")
    await user.click(screen.getByRole("checkbox", { name: "Finance" }))
    await user.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByText("Metadata updated.")).toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: "Edit metadata" })
    ).not.toBeInTheDocument()
    expect(
      JSON.parse(
        String(
          fetcher.mock.calls.find(
            ([, options]) => options?.method === "PATCH"
          )?.[1]?.body
        )
      )
    ).toEqual({
      title: "Updated policy",
      issuer: null,
      categoryId: null,
      tagIds: [],
    })
    expect(invalidation).toHaveBeenCalledWith({ queryKey: ["documents", id] })
    expect(invalidation).toHaveBeenCalledWith({
      queryKey: ["document", id, id],
    })
  })
  it("updates and clears description through the existing PATCH and keeps current version", async () => {
    current = { ...detail, description: "Existing description" }
    const fetcher = mockApi((url) =>
      url.includes("/documents?") ? json(envelope([current])) : undefined
    )
    const view = render(tree(true))
    const user = userEvent.setup()
    expect(
      await screen.findByRole("link", { name: detail.title })
    ).toHaveAttribute("href", `/documents/${id}`)
    expect(await screen.findByText("Existing description")).toBeInTheDocument()
    expect(
      screen.getByText(detail.currentVersion.originalFilename)
    ).toBeInTheDocument()
    view.rerender(tree())
    expect(
      await screen.findByRole("heading", { name: detail.title })
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Edit metadata" }))
    const description = screen.getByLabelText("Description (optional)")
    expect(description).toHaveValue("Existing description")
    await user.clear(description)
    await user.type(description, "Updated description")
    await user.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByText("Updated description")).toBeInTheDocument()
    const patches = () =>
      fetcher.mock.calls
        .filter(([, options]) => options?.method === "PATCH")
        .map(([, options]) => JSON.parse(String(options?.body)))
    expect(patches()).toEqual([{ description: "Updated description" }])
    expect(
      screen.getByText(detail.currentVersion.originalFilename)
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Edit metadata" }))
    await user.clear(screen.getByLabelText("Description (optional)"))
    await user.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByText("No description")).toBeInTheDocument()
    expect(patches()).toEqual([
      { description: "Updated description" },
      { description: null },
    ])
    expect(
      screen.getByText(detail.currentVersion.originalFilename)
    ).toBeInTheDocument()
  })
  it("retains a failed description draft and leaves the saved value after cancel", async () => {
    current = { ...detail, description: "Saved description" }
    const fetcher = mockApi((_url, options) =>
      options?.method === "PATCH"
        ? json({ error: { message: "private provider path" } }, 503)
        : undefined
    )
    render(tree())
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole("button", { name: "Edit metadata" })
    )
    await user.clear(screen.getByLabelText("Description (optional)"))
    await user.type(
      screen.getByLabelText("Description (optional)"),
      "Draft description"
    )
    await user.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.getByLabelText("Description (optional)")).toHaveValue(
      "Draft description"
    )
    expect(screen.queryByText("private provider path")).not.toBeInTheDocument()
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(true)
    await user.click(screen.getByRole("button", { name: "Cancel editing" }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(screen.getByText("Saved description")).toBeInTheDocument()
    expect(
      fetcher.mock.calls.filter(([, options]) => options?.method === "PATCH")
    ).toHaveLength(1)
  })
  it("rejects invalid date order and allows selecting category/tag IDs", async () => {
    const fetcher = mockApi()
    render(tree())
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole("button", { name: "Edit metadata" })
    )
    await chooseDate("Expiration date (optional)", "2026-08-01")
    await user.click(screen.getByRole("button", { name: "Save changes" }))
    expect(
      await screen.findByText(
        "Expiration cannot be earlier than the document date."
      )
    ).toBeInTheDocument()
    await chooseDate("Expiration date (optional)", "2027-09-01")
    await user.selectOptions(
      screen.getByLabelText("Category (optional)"),
      secondId
    )
    await user.click(screen.getByRole("checkbox", { name: "Other tag" }))
    await user.click(screen.getByRole("button", { name: "Save changes" }))
    await screen.findByText("Metadata updated.")
    const patch = JSON.parse(
      String(
        fetcher.mock.calls.find(
          ([, options]) => options?.method === "PATCH"
        )?.[1]?.body
      )
    )
    expect(patch.categoryId).toBe(secondId)
    expect(patch.tagIds).toEqual([id, secondId])
  }, 15000) // Includes thirteen real calendar month-navigation interactions.
  it.each([400, 409, 503])(
    "preserves editing on recoverable update %i",
    async (status) => {
      mockApi((_url, options) =>
        options?.method === "PATCH"
          ? json({ error: { message: "private filesystem path" } }, status)
          : undefined
      )
      render(tree())
      const user = userEvent.setup()
      await user.click(
        await screen.findByRole("button", { name: "Edit metadata" })
      )
      await user.type(screen.getByLabelText("Title *"), " changed")
      await user.click(screen.getByRole("button", { name: "Save changes" }))
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
      expect(screen.getByLabelText("Title *")).toHaveValue(
        `${detail.title} changed`
      )
      expect(
        screen.queryByText("private filesystem path")
      ).not.toBeInTheDocument()
      if (status === 409)
        expect(screen.getByRole("alert")).toHaveTextContent(
          "may have changed elsewhere"
        )
    }
  )
  it("warns on unsaved cancellation and restores edit-trigger focus", async () => {
    mockApi()
    render(tree())
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole("button", { name: "Edit metadata" })
    )
    await user.type(screen.getByLabelText("Title *"), " changed")
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    await user.click(screen.getByRole("button", { name: "Cancel editing" }))
    expect(screen.getByLabelText("Title *")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel editing" }))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit metadata" })
      ).toHaveFocus()
    )
    expect(confirm).toHaveBeenCalledTimes(2)
  })
  it("requires confirmation, traps focus and safely cancels archive", async () => {
    const fetcher = mockApi()
    render(tree())
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Archive" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("does not delete the file")
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Cancel" })
      ).toHaveFocus()
    )
    await user.tab({ shift: true })
    expect(
      within(dialog).getByRole("button", { name: "Confirm archive" })
    ).toHaveFocus()
    await user.keyboard("{Escape}")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Archive" })).toHaveFocus()
    )
    expect(
      fetcher.mock.calls.some(([url]) => String(url).endsWith("/archive"))
    ).toBe(false)
  })
  it("archives then restores using returned server state", async () => {
    mockApi()
    render(tree())
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Archive" }))
    await user.click(screen.getByRole("button", { name: "Confirm archive" }))
    expect(
      await screen.findByText("Document archived. Its file is preserved.")
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Edit metadata" })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Restore" }))
    await user.click(screen.getByRole("button", { name: "Confirm restore" }))
    expect(await screen.findByText("Document restored.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit metadata" })).toBeEnabled()
  })
  it("soft-deletes only after confirmation then redirects with a list notification", async () => {
    const fetcher = mockApi()
    const view = render(tree())
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Delete" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent(detail.title)
    expect(dialog).toHaveTextContent("not permanent purge")
    expect(
      fetcher.mock.calls.some(([, options]) => options?.method === "DELETE")
    ).toBe(false)
    await user.click(
      within(dialog).getByRole("button", { name: "Confirm delete" })
    )
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/documents")
    )
    view.rerender(tree(true))
    expect(
      await screen.findByText(/has not been permanently purged/)
    ).toBeInTheDocument()
  })
  it("disables lifecycle actions for deleting documents", async () => {
    current = { ...current, status: "DELETING" }
    mockApi()
    render(tree())
    expect(await screen.findByRole("button", { name: "Delete" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Download current file" })
    ).toBeDisabled()
  })
  it("disables download when the authorized endpoint reports no current file", async () => {
    const fetcher = mockApi((url) =>
      url.endsWith("/download") ? json({}, 409) : undefined
    )
    render(tree())
    await userEvent.click(
      await screen.findByRole("button", { name: "Download current file" })
    )
    expect(
      await screen.findByText(/No unambiguous current file/)
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Download current file" })
    ).toBeDisabled()
    expect(
      fetcher.mock.calls.some(
        ([url]) => String(url) === `/api/v1/documents/${id}/download`
      )
    ).toBe(true)
  })
  it("prevents duplicate archive submission and keeps errors in its dialog", async () => {
    let complete!: (value: Response) => void
    const fetcher = mockApi((url) =>
      url.endsWith("/archive")
        ? new Promise((resolve) => {
            complete = resolve
          })
        : undefined
    )
    render(tree())
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Archive" }))
    await user.dblClick(screen.getByRole("button", { name: "Confirm archive" }))
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([url]) => String(url).endsWith("/archive"))
      ).toHaveLength(1)
    )
    await act(async () => complete(json({}, 409)))
    expect(
      within(screen.getByRole("alertdialog")).getByRole("alert")
    ).toHaveTextContent("conflicts")
  })
})
