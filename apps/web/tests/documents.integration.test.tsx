import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { format, subDays } from "date-fns"
import { chooseDate } from "./date-picker"
import { AuthProvider } from "@/features/auth/provider"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { DocumentsList } from "@/features/documents/documents-list"
import {
  category,
  document,
  envelope,
  id,
  json,
  profile,
  secondId,
  tag,
} from "./documents.fixture"

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  search: "",
}))
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  usePathname: () => "/documents",
  useSearchParams: () => new URLSearchParams(navigation.search),
}))
beforeEach(() => {
  navigation.search = ""
  navigation.push.mockReset()
  navigation.replace.mockReset()
})
function mount() {
  const tree = (
    <AuthProvider>
      <DashboardShell>
        <DocumentsList />
      </DashboardShell>
    </AuthProvider>
  )
  const rendered = render(tree)
  return {
    ...rendered,
    visit: (search: string) => {
      navigation.search = search
      rendered.rerender(
        <AuthProvider>
          <DashboardShell>
            <DocumentsList />
          </DashboardShell>
        </AuthProvider>
      )
    },
  }
}
function mockApi(
  documents: (url: URL) => Response | Promise<Response> = () =>
    json(envelope([document])),
  lookupsFail = false,
  tagRecords = [tag]
) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), "http://localhost")
    if (url.pathname.endsWith("/auth/me")) return json({ data: profile })
    if (url.pathname.endsWith("/categories"))
      return lookupsFail ? json({}, 503) : json(envelope([category]))
    if (url.pathname.endsWith("/tags")) return json(envelope(tagRecords))
    return documents(url)
  })
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}
async function openFilters() {
  await userEvent.click(screen.getByRole("button", { name: "Filters" }))
  return screen.findByRole("dialog", { name: "Filter documents" })
}
async function applyFilters() {
  await userEvent.click(screen.getByRole("button", { name: "Apply filters" }))
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Filter documents" })
    ).not.toBeInTheDocument()
  )
}
describe("documents page with real client and query hooks", () => {
  it("toggles optional columns while keeping the required columns visible", async () => {
    mockApi()
    mount()
    await screen.findByRole("link", { name: document.title })
    const table = screen.getByRole("table", { name: "Documents" })
    for (const name of ["Tags", "Issuer", "Document date", "Expiration"]) {
      await userEvent.click(screen.getByRole("button", { name: "Columns" }))
      const option = await screen.findByRole("menuitemcheckbox", { name })
      expect(option).toHaveAttribute(
        "aria-checked",
        name === "Tags" ? "true" : "false"
      )
      expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(4)
      await userEvent.click(option)
      await userEvent.keyboard("{Escape}")
      if (name === "Tags")
        expect(
          within(table).queryByRole("columnheader", { name })
        ).not.toBeInTheDocument()
      else
        expect(
          within(table).getByRole("columnheader", { name })
        ).toBeInTheDocument()
      for (const required of ["Document", "Status", "Category", "Created"]) {
        expect(
          within(table).getByRole("columnheader", { name: required })
        ).toBeInTheDocument()
      }
    }
  })

  it("renders the full server page in a data table without client reordering or pagination", async () => {
    const page = Array.from({ length: 12 }, (_, index) => ({
      ...document,
      id: `13ee39cf-ed80-4d42-a7ec-${String(index).padStart(12, "0")}`,
      title: `Record ${12 - index}`,
    }))
    mockApi(() => json(envelope(page)))
    mount()
    await screen.findByRole("link", { name: "Record 12" })
    const table = screen.getByRole("table", { name: "Documents" })
    expect(within(table).getAllByRole("row")).toHaveLength(13)
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent)
    ).toEqual(["Document", "Status", "Category", "Tags", "Created"])
    expect(
      within(table)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(page.map((item) => item.title))
    expect(within(table).getAllByRole("link")[11]).toHaveAttribute(
      "href",
      `/documents/${page[11].id}`
    )
    expect(table).not.toHaveTextContent("private-storage-key")
    expect(table).not.toHaveTextContent("private-owner")
    expect(table).not.toHaveTextContent("private-checksum")
  })
  it("shows a clamped description preview and current file metadata from list responses", async () => {
    const description = "Owner notes ".repeat(80)
    const fetcher = mockApi(() =>
      json(
        envelope([
          { ...document, description },
          {
            ...document,
            id: secondId,
            title: "Metadata only",
            description: null,
            currentVersion: null,
          },
        ])
      )
    )
    mount()
    await screen.findByRole("link", { name: document.title })
    const table = screen.getByRole("table", { name: "Documents" })
    expect(within(table).getByText(/Owner notes Owner notes/)).toHaveClass(
      "line-clamp-2"
    )
    expect(
      within(table).getByText(document.currentVersion.originalFilename)
    ).toBeInTheDocument()
    expect(
      within(table).getByText(`v${document.currentVersion.versionNumber}`)
    ).toBeInTheDocument()
    expect(within(table).getByText("PDF")).toBeInTheDocument()
    expect(within(table).getByText("1.0 KiB")).toBeInTheDocument()
    expect(
      within(table).getByRole("link", { name: "Metadata only" })
    ).toBeInTheDocument()
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("/versions"))
    ).toBe(false)
  })

  it("maps category, tag, archive and sort controls into bookmarked API queries", async () => {
    const fetcher = mockApi()
    const view = mount()
    await screen.findByText(document.title)
    await openFilters()
    for (const [name, option] of [
      ["Category", "Records"],
      ["Archive state", "Archived"],
    ]) {
      await userEvent.click(screen.getByRole("combobox", { name }))
      await userEvent.click(await screen.findByRole("option", { name: option }))
      expect(navigation.push).not.toHaveBeenCalled()
    }
    await userEvent.click(
      screen.getByRole("button", { name: "Tags (match all)" })
    )
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Finance" })
    )
    expect(navigation.push).not.toHaveBeenCalled()
    await applyFilters()
    let url = navigation.push.mock.lastCall?.[0] as string
    expect(
      new URL(url, "http://localhost").searchParams.get("categoryId")
    ).toBe(id)
    expect(new URL(url, "http://localhost").searchParams.get("archived")).toBe(
      "true"
    )
    expect(new URL(url, "http://localhost").searchParams.get("tagIds")).toBe(id)
    view.visit(url.split("?")[1])
    await userEvent.click(
      screen.getByRole("combobox", { name: "Sort direction" })
    )
    await userEvent.click(
      await screen.findByRole("option", { name: "Ascending" })
    )
    url = navigation.push.mock.lastCall?.[0] as string
    expect(new URL(url, "http://localhost").searchParams.get("sort")).toBe(
      "createdAt"
    )
    view.visit(url.split("?")[1])
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url]) =>
            String(url).includes("archived=true") &&
            String(url).includes("sort=createdAt") &&
            String(url).includes(`tagIds=${id}`)
        )
      ).toBe(true)
    )
  })
  it("supports empty category/tag collections and a terminal result page", async () => {
    const fetcher = mockApi()
    fetcher.mockImplementation(async (input) =>
      String(input).includes("/auth/me")
        ? json({ data: profile })
        : json(envelope([]))
    )
    mount()
    await screen.findByText("No documents yet")
    await openFilters()
    expect(screen.getByRole("combobox", { name: "Category" })).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Tags (match all)" })
    ).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled()
    expect(
      screen.queryByRole("button", { name: "Load more categories" })
    ).not.toBeInTheDocument()
  })
  it("renders only public fields, correct links and real filter options", async () => {
    mockApi()
    mount()
    expect(
      await screen.findByRole("link", { name: document.title })
    ).toHaveAttribute("href", `/documents/${id}`)
    expect(
      screen.getByRole("link", { name: "Upload document" })
    ).toHaveAttribute("href", "/documents/upload")
    await openFilters()
    await userEvent.click(screen.getByRole("combobox", { name: "Category" }))
    expect(
      await screen.findByRole("option", { name: "Records" })
    ).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await userEvent.click(
      screen.getByRole("button", { name: "Tags (match all)" })
    )
    expect(
      await screen.findByRole("checkbox", { name: "Finance" })
    ).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(
      screen.getByText("uploaded", { selector: "span" })
    ).toBeInTheDocument()
    expect(screen.queryByText("private-storage-key")).not.toBeInTheDocument()
    expect(screen.queryByText("private-owner")).not.toBeInTheDocument()
    expect(screen.queryByText("private-checksum")).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
      "aria-current",
      "page"
    )
  })
  it("announces loading without fake records", async () => {
    mockApi(() => new Promise(() => {}))
    mount()
    expect(await screen.findByText("Loading documents…")).toHaveAttribute(
      "role",
      "status"
    )
    expect(screen.queryByText(document.title)).not.toBeInTheDocument()
  })
  it("provides first-upload and filtered-empty states", async () => {
    mockApi(() => json(envelope([])))
    const view = mount()
    expect(await screen.findByText("No documents yet")).toBeInTheDocument()
    expect(
      screen.getByRole("searchbox", { name: "Search documents" })
    ).toBeEnabled()
    expect(
      screen.getByRole("link", { name: "Upload your first document" })
    ).toHaveAttribute("href", "/documents/upload")
    view.visit("q=missing")
    expect(await screen.findByText("No matching documents")).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("button", { name: "Clear all filters" })
    )
    expect(navigation.push.mock.lastCall?.[0]).not.toContain("q=")
  })
  it("keeps results available when an optional filter fails", async () => {
    mockApi(undefined, true)
    mount()
    await screen.findByText(document.title)
    await openFilters()
    expect(
      await screen.findByText("Categories unavailable.")
    ).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Category" })).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(await screen.findByText(document.title)).toBeInTheDocument()
  })
  it("shows retry on API failure rather than an empty account", async () => {
    mockApi(() => json({}, 503))
    mount()
    expect(
      await screen.findByText("Unable to load documents")
    ).toBeInTheDocument()
    expect(screen.queryByText("No documents yet")).not.toBeInTheDocument()
    expect(
      screen.getByRole("searchbox", { name: "Search documents" })
    ).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Try again" })
    ).toBeInTheDocument()
  })
  it("stages filters, clears cursors on Apply, debounces search and restores URL state", async () => {
    mockApi()
    navigation.search = "cursor=old_cursor"
    const view = mount()
    await screen.findByText(document.title)
    await openFilters()
    await userEvent.click(screen.getByRole("combobox", { name: "Status" }))
    await userEvent.click(await screen.findByRole("option", { name: "ready" }))
    expect(navigation.push).not.toHaveBeenCalled()
    await applyFilters()
    expect(navigation.push.mock.lastCall?.[0]).toContain("status=READY")
    expect(navigation.push.mock.lastCall?.[0]).not.toContain("cursor")
    view.visit("status=READY")
    const search = screen.getByRole("searchbox", { name: "Search documents" })
    navigation.push.mockClear()
    await userEvent.type(search, "tax")
    expect(navigation.push).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(navigation.push.mock.lastCall?.[0]).toContain("q=tax")
    )
    view.visit("q=tax&status=READY")
    expect(
      screen.getByRole("searchbox", { name: "Search documents" })
    ).toHaveFocus()
    view.visit("q=insurance&status=FAILED")
    expect(
      screen.getByRole("searchbox", { name: "Search documents" })
    ).toHaveValue("insurance")
    await openFilters()
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent(
      "failed"
    )
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    view.visit("")
    expect(
      screen.getByRole("searchbox", { name: "Search documents" })
    ).toHaveValue("")
  })
  it("keeps draft changes private until Apply and discards them on close", async () => {
    mockApi()
    navigation.search =
      "mimeType=application%2Fpdf&sort=-title&cursor=old_cursor"
    mount()
    await screen.findByText(document.title)
    expect(screen.getByRole("button", { name: "Filters" })).toHaveTextContent(
      "1"
    )
    expect(
      screen.queryByRole("combobox", { name: "Current file type" })
    ).not.toBeInTheDocument()
    await openFilters()
    expect(
      screen.getByRole("combobox", { name: "Current file type" })
    ).toHaveTextContent("PDF")
    await userEvent.click(
      screen.getByRole("combobox", { name: "Current file type" })
    )
    await userEvent.click(
      await screen.findByRole("option", { name: "JPEG image" })
    )
    expect(navigation.push).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(navigation.push).not.toHaveBeenCalled()
    await openFilters()
    expect(
      screen.getByRole("combobox", { name: "Current file type" })
    ).toHaveTextContent("PDF")
    await userEvent.click(screen.getByRole("button", { name: "Clear" }))
    expect(
      screen.getByRole("combobox", { name: "Current file type" })
    ).toHaveTextContent("All file types")
    expect(navigation.push).not.toHaveBeenCalled()
    await applyFilters()
    const params = new URL(
      navigation.push.mock.lastCall?.[0] as string,
      "http://localhost"
    ).searchParams
    expect(params.has("mimeType")).toBe(false)
    expect(params.has("cursor")).toBe(false)
    expect(params.get("sort")).toBe("-title")
  })
  it("counts filter categories without counting tags, range endpoints or sort", async () => {
    mockApi()
    navigation.search = `mimeType=application%2Fpdf&tagIds=${id},${secondId}&createdFrom=2026-01-01&createdTo=2026-12-31&sort=-title&cursor=old_cursor`
    mount()
    await screen.findByText(document.title)
    expect(screen.getByRole("button", { name: "Filters" })).toHaveTextContent(
      "3"
    )
    await openFilters()
    expect(
      screen.getByRole("button", { name: "Created from" })
    ).toHaveTextContent("2026-01-01")
    expect(
      screen.getByRole("button", { name: "Created to" })
    ).toHaveTextContent("2026-12-31")
    await userEvent.keyboard("{Escape}")
    expect(
      screen.queryByRole("dialog", { name: "Filter documents" })
    ).not.toBeInTheDocument()
  })
  it("follows the returned cursor while preserving filters and announces page loading", async () => {
    mockApi((url) =>
      url.searchParams.has("cursor")
        ? new Promise(() => {})
        : json(envelope([document], "next_cursor"))
    )
    navigation.search = "q=policy"
    const view = mount()
    await screen.findByText(document.title)
    await userEvent.click(screen.getByRole("button", { name: "Next page" }))
    const next = navigation.push.mock.lastCall?.[0] as string
    expect(next).toContain("q=policy")
    expect(next).toContain("cursor=next_cursor")
    view.visit(next.split("?")[1])
    expect(await screen.findByText("Loading this view…")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled()
  })
  it("stages filename, MIME, all-of tags and UTC dates until Apply", async () => {
    const secondTag = { ...tag, id: secondId, name: "2026" }
    const fetcher = mockApi(undefined, false, [tag, secondTag])
    navigation.search = "cursor=old_cursor&sort=-updatedAt"
    const view = mount()
    await screen.findByText(document.title)
    await openFilters()
    await userEvent.type(
      screen.getByRole("textbox", { name: "Current filename" }),
      "Annual Report"
    )
    await userEvent.click(
      screen.getByRole("combobox", { name: "Current file type" })
    )
    await userEvent.click(await screen.findByRole("option", { name: "PDF" }))
    await userEvent.click(
      screen.getByRole("button", { name: "Tags (match all)" })
    )
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Finance" })
    )
    await userEvent.click(screen.getByRole("checkbox", { name: "2026" }))
    await userEvent.keyboard("{Escape}")
    const day = format(new Date(), "yyyy-MM-dd")
    await chooseDate("Created from", day)
    await chooseDate("Created to", day)
    await chooseDate("Updated from", day)
    await chooseDate("Updated to", day)
    expect(navigation.push).not.toHaveBeenCalled()
    await applyFilters()
    const url = navigation.push.mock.lastCall?.[0] as string
    const params = new URL(url, "http://localhost").searchParams
    expect(params.get("filename")).toBe("Annual Report")
    expect(params.get("mimeType")).toBe("application/pdf")
    expect(params.get("tagIds")).toBe(id + "," + secondId)
    for (const key of ["createdFrom", "createdTo", "updatedFrom", "updatedTo"])
      expect(params.get(key)).toBe(day)
    expect(params.get("sort")).toBe("-updatedAt")
    expect(params.has("cursor")).toBe(false)
    view.visit(url.split("?")[1])
    expect(screen.getByLabelText("Active filters")).toHaveTextContent(
      "Tag: Finance"
    )
    expect(screen.getByLabelText("Active filters")).toHaveTextContent(
      "Tag: 2026"
    )
    expect(screen.getByRole("button", { name: "Filters" })).toHaveTextContent(
      "5"
    )
    expect(
      fetcher.mock.calls.some(([request]) =>
        String(request).includes("tagIds=")
      )
    ).toBe(true)
    await userEvent.click(
      screen.getByRole("button", {
        name: "Remove Filename: Annual Report filter",
      })
    )
    const removed = navigation.push.mock.lastCall?.[0] as string
    expect(
      new URL(removed, "http://localhost").searchParams.has("filename")
    ).toBe(false)
    view.visit(removed.split("?")[1])
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }))
    const cleared = new URL(
      navigation.push.mock.lastCall?.[0] as string,
      "http://localhost"
    )
    expect(cleared.searchParams.get("sort")).toBe("-updatedAt")
    expect(cleared.searchParams.has("tagIds")).toBe(false)
  }, 15000)
  it("rejects reversed date ranges and exposes only supported sort directions", async () => {
    mockApi()
    const view = mount()
    await screen.findByText(document.title)
    await openFilters()
    await chooseDate("Created from", format(new Date(), "yyyy-MM-dd"))
    await chooseDate("Created to", format(subDays(new Date(), 1), "yyyy-MM-dd"))
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }))
    expect(await screen.findByRole("alert", { name: "" })).toHaveTextContent(
      "start date"
    )
    expect(navigation.push).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Clear" }))
    await applyFilters()

    await userEvent.click(screen.getByRole("combobox", { name: "Sort by" }))
    for (const option of [
      "Created date",
      "Updated date",
      "Title",
      "Current file size",
    ])
      expect(screen.getByRole("option", { name: option })).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("option", { name: "Current file size" })
    )
    let url = navigation.push.mock.lastCall?.[0] as string
    expect(new URL(url, "http://localhost").searchParams.get("sort")).toBe(
      "-fileSize"
    )
    view.visit(url.split("?")[1])
    await userEvent.click(
      screen.getByRole("combobox", { name: "Sort direction" })
    )
    expect(
      screen.queryByRole("option", { name: "Ascending" })
    ).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await userEvent.click(screen.getByRole("combobox", { name: "Sort by" }))
    await userEvent.click(await screen.findByRole("option", { name: "Title" }))
    url = navigation.push.mock.lastCall?.[0] as string
    expect(new URL(url, "http://localhost").searchParams.get("sort")).toBe(
      "-title"
    )
    view.visit(url.split("?")[1])
    expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveTextContent(
      "Title"
    )
    await userEvent.click(
      screen.getByRole("combobox", { name: "Sort direction" })
    )
    await userEvent.click(
      await screen.findByRole("option", { name: "Ascending" })
    )
    url = navigation.push.mock.lastCall?.[0] as string
    expect(new URL(url, "http://localhost").searchParams.get("sort")).toBe(
      "title"
    )
  })
  it("navigates next and previous using opaque cursor history, then resets it on a filter change", async () => {
    mockApi((url) => {
      const cursor = url.searchParams.get("cursor")
      return json(
        envelope(
          [document],
          cursor === "cursor_b"
            ? null
            : cursor === "cursor_a"
              ? "cursor_b"
              : "cursor_a"
        )
      )
    })
    const view = mount()
    await screen.findByText(document.title)
    expect(screen.getByText(/Page 1 · Up to/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: "Next page" }))
    let url = navigation.push.mock.lastCall?.[0] as string
    expect(new URL(url, "http://localhost").searchParams.get("cursor")).toBe(
      "cursor_a"
    )
    view.visit(url.split("?")[1])
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled()
    )
    expect(screen.getByText(/Page 2 · Up to/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Next page" }))
    url = navigation.push.mock.lastCall?.[0] as string
    expect(new URL(url, "http://localhost").searchParams.get("cursor")).toBe(
      "cursor_b"
    )
    view.visit(url.split("?")[1])
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled()
    )
    expect(screen.getByText(/Page 3 · Up to/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }))
    url = navigation.push.mock.lastCall?.[0] as string
    expect(new URL(url, "http://localhost").searchParams.get("cursor")).toBe(
      "cursor_a"
    )
    view.visit(url.split("?")[1])
    await openFilters()
    await userEvent.click(
      screen.getByRole("combobox", { name: "Current file type" })
    )
    await userEvent.click(screen.getByRole("option", { name: "PDF" }))
    await applyFilters()
    url = navigation.push.mock.lastCall?.[0] as string
    expect(url).not.toContain("cursor=")
    view.visit(url.split("?")[1])
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled()
    )
    await userEvent.click(screen.getByRole("button", { name: "Next page" }))
    url = navigation.push.mock.lastCall?.[0] as string
    view.visit(url.split("?")[1])
    await userEvent.click(screen.getByRole("combobox", { name: "Sort by" }))
    await userEvent.click(await screen.findByRole("option", { name: "Title" }))
    url = navigation.push.mock.lastCall?.[0] as string
    expect(url).not.toContain("cursor=")
    view.visit(url.split("?")[1])
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled()
  })
  it("loads further lookup pages explicitly without unbounded fetching", async () => {
    const fetcher = mockApi()
    fetcher.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes("/auth/me")) return json({ data: profile })
      if (url.includes("/categories"))
        return json(
          envelope(
            url.includes("cursor=")
              ? [{ ...category, id: secondId, name: "More records" }]
              : [category],
            url.includes("cursor=") ? null : id
          )
        )
      if (url.includes("/tags")) return json(envelope([]))
      return json(envelope([document]))
    })
    mount()
    await screen.findByText(document.title)
    await openFilters()
    await userEvent.click(
      await screen.findByRole("button", { name: "Load more categories" })
    )
    await userEvent.click(screen.getByRole("combobox", { name: "Category" }))
    expect(
      await screen.findByRole("option", { name: "More records" })
    ).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Records" })).toBeInTheDocument()
  })
  it("redirects when a catalog request and refresh confirm expiry", async () => {
    const fetcher = mockApi()
    let initial = true
    fetcher.mockImplementation(async (input) => {
      if (String(input).endsWith("/auth/me") && initial) {
        initial = false
        return json({ data: profile })
      }
      return json({}, 401)
    })
    mount()
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/login")
    )
    expect(screen.queryByText(document.title)).not.toBeInTheDocument()
  })
  it("supports keyboard focus on the search, Filters and Columns controls", async () => {
    mockApi()
    mount()
    await screen.findByText(document.title)
    const search = screen.getByRole("searchbox", { name: "Search documents" })
    act(() => search.focus())
    expect(search).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole("button", { name: "Filters" })).toHaveFocus()
  })
})
