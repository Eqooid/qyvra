import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { AuthProvider } from "@/features/auth/provider"
import { SearchWorkspace } from "@/features/search/search-page"
import { SafeHighlight } from "@/features/search/safe-highlight"
import {
  searchId,
  searchJson,
  searchResponse,
  lexicalSource,
} from "./search.fixture"
vi.mock("next/navigation", () => ({
  usePathname: () => "/search",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}))
function workspace() {
  return render(
    <AuthProvider>
      <SearchWorkspace owner={searchId} />
    </AuthProvider>
  )
}
async function submit(query = "private") {
  await userEvent.type(
    screen.getByRole("combobox", { name: "Search query" }),
    query
  )
  await userEvent.click(
    screen.getByRole("button", { name: "Search documents" })
  )
}
it("renders scalar highlights as literal text and rejects overlapping, out-of-bounds and fractional ranges", () => {
  const view = render(
    <SafeHighlight snippet="😀 <img> café" ranges={[{ start: 2, end: 7 }]} />
  )
  expect(view.container.querySelector("mark")?.textContent).toBe("<img>")
  expect(view.container.querySelector("img")).toBeNull()
  for (const ranges of [
    [{ start: 0, end: 99 }],
    [
      { start: 0, end: 2 },
      { start: 1, end: 3 },
    ],
    [{ start: 0.5, end: 2 }],
  ]) {
    view.rerender(<SafeHighlight snippet="😀 abc" ranges={ranges} />)
    expect(view.container.querySelector("mark")).toBeNull()
    expect(view.container.textContent).toBe("😀 abc")
  }
})
it("searches on submission, renders safe evidence, opens exact version/page in a sheet and returns focus without losing query", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url) =>
      searchJson(
        String(url).includes("/extractions/")
          ? lexicalSource
          : String(url).endsWith("suggestions")
            ? { suggestions: [] }
            : searchResponse
      )
    )
  )
  const view = workspace()
  await submit()
  expect(await screen.findByText("Private report")).toBeInTheDocument()
  expect(view.container.querySelector("script")).toBeNull()
  expect(view.container.querySelector("mark")?.textContent).toBe("private")
  const trigger = screen.getByRole("button", { name: "View page 2 source" })
  await userEvent.click(trigger)
  expect(await screen.findByText("Exact page two")).toBeInTheDocument()
  expect(screen.getByText(/Version 2 · Page 2/)).toBeInTheDocument()
  await userEvent.keyboard("{Escape}")
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(screen.getByRole("combobox", { name: "Search query" })).toHaveValue(
    "private"
  )
})
it("debounces private suggestions, supports arrows/Enter/Escape and never submits on selection", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    searchJson({
      suggestions: [
        {
          text: "Private report",
          type: "title",
          documentId: searchId,
          documentVersionId: searchId,
        },
      ],
    })
  )
  vi.stubGlobal("fetch", fetcher)
  workspace()
  const input = screen.getByRole("combobox", { name: "Search query" })
  await userEvent.type(input, "pri")
  expect(fetcher).not.toHaveBeenCalled()
  expect(await screen.findByRole("option")).toHaveTextContent("Private report")
  await userEvent.keyboard("{ArrowDown}")
  expect(input.getAttribute("aria-activedescendant")).toBe(
    screen.getByRole("option").id
  )
  await userEvent.keyboard("{Enter}")
  expect(input).toHaveValue("Private report")
  expect(screen.queryByRole("option")).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.every(([url]) => String(url).endsWith("suggestions"))
  ).toBe(true)
  await userEvent.type(input, "x")
  await screen.findByRole("option")
  await userEvent.keyboard("{Escape}")
  expect(input).toHaveAttribute("aria-expanded", "false")
})
it("ignores late search replies after query changes and prevents duplicate submits", async () => {
  let finish!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>((url) =>
    String(url).endsWith("suggestions")
      ? Promise.resolve(searchJson({ suggestions: [] }))
      : new Promise((resolve) => {
          finish = resolve
        })
  )
  vi.stubGlobal("fetch", fetcher)
  workspace()
  await submit()
  expect(
    screen.getByRole("button", { name: "Search documents" })
  ).toBeDisabled()
  await userEvent.type(
    screen.getByRole("combobox", { name: "Search query" }),
    " changed"
  )
  finish(searchJson(searchResponse))
  await waitFor(() =>
    expect(screen.queryByText("Private report")).not.toBeInTheDocument()
  )
  expect(
    screen.queryByRole("status", { name: "Searching" })
  ).not.toBeInTheDocument()
})
it("keeps autocomplete failure optional and shows bounded empty results without fake totals", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("suggestions")
        ? searchJson({}, 503)
        : searchJson({ ...searchResponse, results: [] })
    )
  )
  workspace()
  await submit("unmatched")
  expect(await screen.findByText(/No matching documents/)).toBeInTheDocument()
  expect(screen.getByText(/Coverage is not a match count/)).toBeInTheDocument()
  expect(screen.getByText(/End of available results/)).toBeInTheDocument()
})
it("uses opaque next cursors with the same request, replaces pages, and recovers expired windows", async () => {
  let count = 0
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith("suggestions"))
      return searchJson({ suggestions: [] })
    count++
    return count === 1
      ? searchJson({
          ...searchResponse,
          pagination: {
            ...searchResponse.pagination,
            nextCursor: "opaque",
            hasMore: true,
          },
        })
      : count === 2
        ? searchJson({}, 409)
        : searchJson(searchResponse)
  })
  vi.stubGlobal("fetch", fetcher)
  workspace()
  await submit()
  await userEvent.click(
    await screen.findByRole("button", { name: "Next page" })
  )
  expect(await screen.findByRole("alert")).toHaveTextContent("expired")
  const requests = fetcher.mock.calls
    .filter(([url]) => String(url).endsWith("keyword"))
    .map(([, init]) => JSON.parse(init!.body as string))
  expect(requests[1]).toEqual({ ...requests[0], cursor: "opaque" })
  await userEvent.click(screen.getByRole("button", { name: "Restart search" }))
  expect(await screen.findByText("Private report")).toBeInTheDocument()
})
it("validates blank search and clears state on reset", async () => {
  vi.stubGlobal("fetch", vi.fn())
  workspace()
  await userEvent.click(
    screen.getByRole("button", { name: "Search documents" })
  )
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Enter a search query"
  )
  await userEvent.type(
    screen.getByRole("combobox", { name: "Search query" }),
    "secret"
  )
  await userEvent.click(screen.getByRole("button", { name: "Clear search" }))
  expect(screen.getByRole("combobox", { name: "Search query" })).toHaveValue("")
  expect(window.location.search).toBe("")
  expect(localStorage.length).toBe(0)
})
it("handles punctuation-only autocomplete locally without an uncaught error or blocking search", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    searchJson({ ...searchResponse, results: [] })
  )
  vi.stubGlobal("fetch", fetcher)
  workspace()
  await userEvent.type(
    screen.getByRole("combobox", { name: "Search query" }),
    "!!!"
  )
  expect(
    await screen.findByText(
      "Suggestions unavailable. You can still submit your search."
    )
  ).toBeInTheDocument()
  expect(fetcher).not.toHaveBeenCalled()
  await userEvent.click(
    screen.getByRole("button", { name: "Search documents" })
  )
  expect(await screen.findByText(/No matching documents/)).toBeInTheDocument()
})
it("discards delayed suggestions after the query changes", async () => {
  let finish!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal("fetch", fetcher)
  workspace()
  const input = screen.getByRole("combobox", { name: "Search query" })
  await userEvent.type(input, "private")
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  await userEvent.clear(input)
  finish(
    searchJson({
      suggestions: [
        {
          text: "Private report",
          type: "title",
          documentId: searchId,
          documentVersionId: searchId,
        },
      ],
    })
  )
  await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "false"))
  expect(screen.queryByRole("option")).not.toBeInTheDocument()
})
it("applies and resets approved filters, drops old results and sends filters with the new query", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    searchJson(
      String(url).endsWith("suggestions") ? { suggestions: [] } : searchResponse
    )
  )
  vi.stubGlobal("fetch", fetcher)
  workspace()
  await submit()
  await screen.findByText("Private report")
  await userEvent.click(screen.getByRole("button", { name: "Filters" }))
  await userEvent.type(screen.getByLabelText("Filename contains"), "report")
  await userEvent.click(screen.getByRole("button", { name: "Apply filters" }))
  expect(screen.queryByText("Private report")).not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole("button", { name: "Search documents" })
  )
  await screen.findByText("Private report")
  const requests = fetcher.mock.calls.filter(([url]) =>
    String(url).endsWith("keyword")
  )
  expect(JSON.parse(requests.at(-1)![1]!.body as string).filters).toEqual({
    filename: "report",
  })
  await userEvent.click(screen.getByRole("button", { name: "Filters (1)" }))
  await userEvent.click(screen.getByRole("button", { name: "Reset filters" }))
  expect(screen.queryByText(/Active filters/)).not.toBeInTheDocument()
})
it("offers explicit keyword choice when hybrid is unavailable and does not silently resubmit", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("hybrid")
      ? searchJson({}, 503)
      : searchJson({ suggestions: [] })
  )
  vi.stubGlobal("fetch", fetcher)
  workspace()
  await userEvent.click(screen.getByRole("combobox", { name: "Search mode" }))
  await userEvent.click(screen.getByRole("option", { name: "Hybrid" }))
  await submit()
  expect(await screen.findByRole("alert")).toHaveTextContent("unavailable")
  await userEvent.click(
    screen.getByRole("button", { name: "Use Keyword mode" })
  )
  expect(
    screen.getByRole("combobox", { name: "Search mode" })
  ).toHaveTextContent("Keyword")
  expect(
    fetcher.mock.calls.some(([url]) => String(url).endsWith("keyword"))
  ).toBe(false)
})
