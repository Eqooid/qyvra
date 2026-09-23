import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
  lookupsFail = false
) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), "http://localhost")
    if (url.pathname.endsWith("/auth/me")) return json({ data: profile })
    if (url.pathname.endsWith("/categories"))
      return lookupsFail ? json({}, 503) : json(envelope([category]))
    if (url.pathname.endsWith("/tags")) return json(envelope([tag]))
    return documents(url)
  })
  vi.stubGlobal("fetch", fetcher)
  return fetcher
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

  it("maps category, tag, archive and sort controls into bookmarked API queries", async () => {
    const fetcher = mockApi()
    const view = mount()
    await screen.findByText(document.title)
    for (const [name, value, key, option] of [
      ["Category", id, "categoryId", "Records"],
      ["Tag", id, "tagId", "Finance"],
      ["Archive state", "true", "archived", "Archived"],
      ["Sort", "createdAt", "sort", "Oldest first"],
    ]) {
      await userEvent.click(screen.getByRole("combobox", { name }))
      await userEvent.click(await screen.findByRole("option", { name: option }))
      const url = navigation.push.mock.lastCall?.[0] as string
      expect(new URL(url, "http://localhost").searchParams.get(key)).toBe(value)
      view.visit(url.split("?")[1])
    }
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url]) =>
            String(url).includes("archived=true") &&
            String(url).includes("sort=createdAt") &&
            String(url).includes(`tagId=${id}`)
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
    expect(screen.getByRole("combobox", { name: "Category" })).toBeEnabled()
    expect(screen.getByRole("combobox", { name: "Tag" })).toBeEnabled()
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
    await userEvent.click(screen.getByRole("combobox", { name: "Category" }))
    expect(
      await screen.findByRole("option", { name: "Records" })
    ).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await userEvent.click(screen.getByRole("combobox", { name: "Tag" }))
    expect(
      await screen.findByRole("option", { name: "Finance" })
    ).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
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
    expect(navigation.push).toHaveBeenCalledWith("/documents", {
      scroll: false,
    })
  })
  it("keeps results available when an optional filter fails", async () => {
    mockApi(undefined, true)
    mount()
    expect(
      await screen.findByText("Categories unavailable.")
    ).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Category" })).toBeDisabled()
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
  it("updates filters immediately, clears cursors, debounces search and restores URL on navigation", async () => {
    mockApi()
    navigation.search = "cursor=old_cursor"
    const view = mount()
    await screen.findByText(document.title)
    await userEvent.click(screen.getByRole("combobox", { name: "Status" }))
    await userEvent.click(await screen.findByRole("option", { name: "ready" }))
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
    expect(screen.getByRole("searchbox")).toHaveFocus()
    view.visit("q=insurance&status=FAILED")
    expect(screen.getByRole("searchbox")).toHaveValue("insurance")
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent(
      "failed"
    )
    view.visit("")
    expect(screen.getByRole("searchbox")).toHaveValue("")
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
  it("supports keyboard focus on the table search and Columns control", async () => {
    mockApi()
    mount()
    await screen.findByText(document.title)
    const search = screen.getByRole("searchbox")
    act(() => search.focus())
    expect(search).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole("button", { name: "Columns" })).toHaveFocus()
  })
})
