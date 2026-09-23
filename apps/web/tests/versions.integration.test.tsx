import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"
import { AuthProvider } from "@/features/auth/provider"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { VersionHistory } from "@/features/documents/version-history"
import { id, secondId, json, envelope, profile } from "./documents.fixture"
import { detail } from "./detail.fixture"
import { version, oldVersion, versionReceipt } from "./versions.fixture"
import { TestXHR } from "./upload.fixture"
const navigation = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  usePathname: () => "/documents/versions",
}))
function setup(
  override?: (url: string) => Response | Promise<Response> | undefined,
  document = detail
) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input),
      response = override?.(url)
    if (response) return response
    if (url.endsWith("/auth/me")) return json({ data: profile })
    if (url.includes("/versions?")) return json(envelope([version, oldVersion]))
    if (url.includes("/versions/")) return json({ data: version })
    return json({ data: document })
  })
  vi.stubGlobal("fetch", fetcher)
  render(
    <AuthProvider>
      <DashboardShell>
        <VersionHistory documentId={id} maxBytes={100} />
      </DashboardShell>
    </AuthProvider>
  )
  return fetcher
}
beforeEach(() => {
  TestXHR.requests = []
  vi.stubGlobal("XMLHttpRequest", TestXHR)
  navigation.replace.mockReset()
})
async function selectFile() {
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole("button", { name: "Upload new version" })
  )
  await user.upload(
    screen.getByLabelText("New version file *"),
    new File(["fixture"], "next.pdf", { type: "application/pdf" })
  )
  return user
}
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen
      .getAllByRole("button", { name: "Upload new version" })
      .find((button) => !button.hasAttribute("disabled"))!
  )
  await user.click(
    await screen.findByRole("button", { name: "Confirm upload new version" })
  )
}
it("renders real numbering/current badge and inspects safe metadata", async () => {
  setup()
  expect(await screen.findByText("Version 2")).toBeInTheDocument()
  expect(screen.getAllByText("Current / latest")).toHaveLength(1)
  await userEvent.click(
    screen.getByRole("button", { name: "Inspect version 2" })
  )
  const region = screen.getByRole("region", { name: "Version 2 metadata" })
  expect(
    await within(region).findByText(
      "Pending — extraction is not implemented yet"
    )
  ).toBeInTheDocument()
  expect(within(region).getByText("2.0 KiB")).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(
    /private-storage|private-checksum|private-user/
  )
  expect(
    screen.getByRole("link", { name: "Back to document" })
  ).toHaveAttribute("href", `/documents/${id}`)
  expect(
    screen.queryByRole("button", { name: /Download/ })
  ).not.toBeInTheDocument()
})
it("loads older versions through the cursor", async () => {
  const fetcher = setup((url) =>
    url.includes("/versions?")
      ? json(
          url.includes("cursor=")
            ? envelope([oldVersion])
            : envelope([version], secondId)
        )
      : undefined
  )
  await userEvent.click(
    await screen.findByRole("button", { name: "Load older versions" })
  )
  expect(await screen.findByText("Version 1")).toBeInTheDocument()
  expect(
    fetcher.mock.calls.some(([url]) =>
      String(url).includes(`cursor=${secondId}`)
    )
  ).toBe(true)
})
it("shows a loading skeleton without fake history", async () => {
  setup((url) =>
    url.includes("/versions?") ? new Promise(() => {}) : undefined
  )
  expect(await screen.findByText("Loading versions…")).toHaveAttribute(
    "role",
    "status"
  )
  expect(screen.queryByText("Version 1")).not.toBeInTheDocument()
})
it("shows empty history", async () => {
  setup((url) => (url.includes("/versions?") ? json(envelope([])) : undefined))
  expect(await screen.findByText("No versions yet")).toBeInTheDocument()
})
it.each([403, 404, 503])(
  "handles history HTTP %s safely and allows retry",
  async (status) => {
    let fail = true
    setup((url) =>
      url.includes("/versions?") && fail
        ? json({ error: { message: "/private/storage" } }, status)
        : undefined
    )
    expect(await screen.findByRole("alert")).not.toHaveTextContent(
      "/private/storage"
    )
    fail = false
    await userEvent.click(screen.getByRole("button", { name: "Retry history" }))
    expect(await screen.findByText("Version 2")).toBeInTheDocument()
  }
)
it("redirects expired authentication without exposing history", async () => {
  setup(() => json({}, 401))
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login"))
  expect(screen.queryByText("policy-v2.pdf")).not.toBeInTheDocument()
})
it("disallows uploading archived documents while preserving history", async () => {
  setup(undefined, { ...detail, isArchived: true, status: "ARCHIVED" })
  expect(await screen.findByText("Version 2")).toBeInTheDocument()
  expect(
    screen.getByRole("button", { name: "Upload new version" })
  ).toBeDisabled()
})
it("validates file selection, replacement, removal and cancellation before sending", async () => {
  setup()
  const user = await selectFile()
  const input = screen.getByLabelText("New version file *")
  fireEvent.change(input, {
    target: { files: [new File([], "empty.pdf", { type: "application/pdf" })] },
  })
  expect(screen.getByRole("alert")).toHaveTextContent("empty")
  fireEvent.change(input, {
    target: { files: [new File(["x"], "bad.exe", { type: "text/plain" })] },
  })
  expect(screen.getByRole("alert")).toHaveTextContent("PDF, JPEG or PNG")
  fireEvent.change(input, {
    target: {
      files: [
        new File([new Uint8Array(101)], "large.pdf", {
          type: "application/pdf",
        }),
      ],
    },
  })
  expect(screen.getByRole("alert")).toHaveTextContent("exceeds")
  await user.click(screen.getByRole("button", { name: "Remove file" }))
  expect(screen.getByRole("alert")).toHaveTextContent("Choose one file")
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(TestXHR.requests).toHaveLength(0)
})
it("confirms upload, prevents repeats, reports progress and refreshes authoritative history", async () => {
  let complete = false
  const fetcher = setup((url) =>
    url.includes("/versions?")
      ? json(
          envelope(
            complete
              ? [version, oldVersion]
              : [{ ...oldVersion, isLatest: true }]
          )
        )
      : undefined
  )
  const user = await selectFile()
  await confirm(user)
  const xhr = TestXHR.requests[0]
  await act(async () => xhr.progress(50))
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50")
  expect(screen.getByRole("button", { name: "Please wait…" })).toBeDisabled()
  expect(TestXHR.requests).toHaveLength(1)
  complete = true
  await act(async () => xhr.respond(201, { data: versionReceipt }))
  expect(await screen.findByText(/Version 2 saved/)).toBeInTheDocument()
  expect(await screen.findByText("Version 2")).toBeInTheDocument()
  expect(screen.getByText("Version 1")).toBeInTheDocument()
  expect(screen.getAllByText("Current / latest")).toHaveLength(1)
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes("/versions?"))
      .length
  ).toBeGreaterThan(1)
  expect(
    fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith(`/documents/${id}`)
    ).length
  ).toBeGreaterThan(1)
  expect(screen.queryByLabelText("New version file *")).not.toBeInTheDocument()
})
it("reuses the attempt after network failure and preserves the selected file", async () => {
  setup()
  const user = await selectFile()
  await confirm(user)
  const first = TestXHR.requests[0]
  await act(async () => first.onerror?.())
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Network interrupted"
  )
  await user.click(
    screen.getByRole("button", { name: "Confirm upload new version" })
  )
  expect(TestXHR.requests[1].headers["Idempotency-Key"]).toBe(
    first.headers["Idempotency-Key"]
  )
  await act(async () => TestXHR.requests[1].respond(503, {}))
  expect(screen.getByRole("alert")).toHaveTextContent("unavailable")
})
it("cancels an active upload without claiming rollback", async () => {
  setup()
  const user = await selectFile()
  await confirm(user)
  await user.click(screen.getByRole("button", { name: "Cancel upload" }))
  expect(TestXHR.requests[0].abort).toHaveBeenCalled()
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "may already have completed"
  )
})

it("does not treat a replayed receipt as current when a newer version exists", async () => {
  const third = {
    ...version,
    id: "33ee39cf-ed80-4d42-a7ec-a5df28c297d9",
    versionNumber: 3,
    originalFilename: "third.pdf",
  }
  setup((url) =>
    url.includes("/versions?")
      ? json(envelope([third, { ...version, isLatest: false }, oldVersion]))
      : undefined
  )
  const user = await selectFile()
  await confirm(user)
  await act(async () =>
    TestXHR.requests[0].respond(201, { data: versionReceipt })
  )
  expect(await screen.findByText(/Version 2 saved/)).toBeInTheDocument()
  await waitFor(() =>
    expect(screen.getByText("Version 3").closest("tr")).toHaveTextContent(
      "Current / latest"
    )
  )
  expect(screen.getByText("Version 2").closest("tr")).not.toHaveTextContent(
    "Current / latest"
  )
})
it("does not show stale current badges when post-upload refresh fails", async () => {
  let fail = false
  setup((url) =>
    url.includes("/versions?") && fail ? json({}, 503) : undefined
  )
  const user = await selectFile()
  await confirm(user)
  fail = true
  await act(async () =>
    TestXHR.requests[0].respond(201, { data: versionReceipt })
  )
  expect(await screen.findByText(/Version 2 saved/)).toBeInTheDocument()
  expect(
    await screen.findByRole("button", { name: "Retry history" })
  ).toBeInTheDocument()
  expect(screen.queryByText("Current / latest")).not.toBeInTheDocument()
  expect(screen.queryByLabelText("New version file *")).not.toBeInTheDocument()
})
it("starts a new attempt when the selected file changes", async () => {
  setup()
  const user = await selectFile()
  await confirm(user)
  await act(async () => TestXHR.requests[0].respond(409, {}))
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    })
  )
  await user.upload(
    screen.getByLabelText("New version file *"),
    new File(["different"], "next.png", { type: "image/png" })
  )
  await confirm(user)
  expect(TestXHR.requests[1].headers["Idempotency-Key"]).not.toBe(
    TestXHR.requests[0].headers["Idempotency-Key"]
  )
  await act(async () => TestXHR.requests[1].respond(403, {}))
  expect(screen.getByRole("alert")).toHaveTextContent("not permitted")
})
it("handles unavailable individual metadata without leaking raw errors", async () => {
  setup((url) =>
    url.includes("/versions/")
      ? json({ error: { message: "private storage key" } }, 404)
      : undefined
  )
  await userEvent.click(
    await screen.findByRole("button", { name: "Inspect version 2" })
  )
  expect(await screen.findByRole("alert")).toHaveTextContent("unavailable")
  expect(screen.getByRole("alert")).not.toHaveTextContent("private storage key")
})
