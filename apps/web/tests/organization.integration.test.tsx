import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { act, render, screen, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AuthProvider } from "@/features/auth/provider"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { OrganizationPage } from "@/features/organization/organization-page"
import type { OrganizationItem, OrganizationKind } from "@/lib/api/organization"
import {
  id,
  secondId,
  profile,
  category,
  tag,
  json,
  envelope,
} from "./documents.fixture"
const navigation = vi.hoisted(() => ({ path: "/categories", replace: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  usePathname: () => navigation.path,
}))
let invalidate: ReturnType<typeof vi.spyOn>
function Observe() {
  const cache = useQueryClient()
  useEffect(() => {
    invalidate = vi.spyOn(cache, "invalidateQueries")
  }, [cache])
  return null
}
function setup(
  kind: OrganizationKind,
  override?: (
    url: string,
    options?: RequestInit
  ) => Response | Promise<Response> | undefined
) {
  navigation.path = `/${kind}`
  let items: OrganizationItem[] = [kind === "categories" ? category : tag]
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = String(input),
      overridden = override?.(url, options)
    if (overridden) return overridden
    if (url.endsWith("/auth/me")) return json({ data: profile })
    const body = options?.body ? JSON.parse(String(options.body)) : {}
    if (options?.method === "POST") {
      const item = {
        ...(kind === "categories" ? category : tag),
        ...body,
        id: secondId,
      }
      items.push(item)
      return json({ data: item }, 201)
    }
    if (options?.method === "PATCH") {
      items = items.map((item) =>
        url.endsWith(item.id) ? { ...item, ...body } : item
      )
      return json({ data: items.find((item) => url.endsWith(item.id)) })
    }
    if (options?.method === "DELETE") {
      items = items.filter((item) => !url.endsWith(item.id))
      return json({ data: { deleted: true } })
    }
    return json(envelope(items))
  })
  vi.stubGlobal("fetch", fetcher)
  render(
    <AuthProvider>
      <Observe />
      <DashboardShell>
        <OrganizationPage kind={kind} />
      </DashboardShell>
    </AuthProvider>
  )
  return fetcher
}
beforeEach(() => navigation.replace.mockReset())
describe.each(["categories", "tags"] as const)(
  "%s management through the real client",
  (kind) => {
    const noun = kind === "categories" ? "category" : "tag",
      name = kind === "categories" ? category.name : tag.name
    async function create() {
      const user = userEvent.setup()
      await user.click(
        await screen.findByRole("button", { name: `Create ${noun}` })
      )
      return { user, dialog: screen.getByRole("dialog") }
    }
    it("lists owned safe fields and exposes a working navigation entry", async () => {
      setup(kind)
      expect(await screen.findByRole("heading", { name })).toBeInTheDocument()
      const table = screen.getByRole("table")
      expect(
        within(table).getByRole("columnheader", { name: "Name" })
      ).toBeInTheDocument()
      expect(
        within(table).getByRole("columnheader", { name: "Updated" })
      ).toBeInTheDocument()
      expect(
        within(table).getByRole("columnheader", { name: "Actions" })
      ).toBeInTheDocument()
      expect(
        within(table).queryByRole("columnheader", { name: "Appearance" }) !==
          null
      ).toBe(kind === "categories")
      expect(within(table).getAllByRole("row")).toHaveLength(2)
      expect(
        screen.getByRole("link", {
          name: kind === "categories" ? "Categories" : "Tags",
        })
      ).toHaveAttribute("aria-current", "page")
      expect(document.body.textContent).not.toContain(profile.id)
    })
    it("shows loading, without fabricated items", async () => {
      setup(kind, (url) =>
        url.includes(`/${kind}?`) ? new Promise(() => {}) : undefined
      )
      expect(await screen.findByText(`Loading ${kind}…`)).toHaveAttribute(
        "role",
        "status"
      )
      expect(screen.queryByRole("heading", { name })).not.toBeInTheDocument()
    })
    it("shows empty state", async () => {
      setup(kind, (url) =>
        url.includes(`/${kind}?`) ? json(envelope([])) : undefined
      )
      expect(await screen.findByText(`No ${kind} yet`)).toBeInTheDocument()
    })
    it("retries list errors", async () => {
      let fail = true
      setup(kind, (url) =>
        url.includes(`/${kind}?`) && fail ? json({}, 503) : undefined
      )
      expect(await screen.findByRole("alert")).toBeInTheDocument()
      fail = false
      await userEvent.click(screen.getByRole("button", { name: "Try again" }))
      expect(await screen.findByRole("heading", { name })).toBeInTheDocument()
    })
    it("creates a normalized item and refreshes options and document caches", async () => {
      const fetcher = setup(kind)
      const { user, dialog } = await create()
      await user.type(within(dialog).getByLabelText("Name *"), "  New   Label ")
      if (kind === "categories") {
        await user.selectOptions(
          screen.getByLabelText("Color (optional)"),
          "#2563eb"
        )
        await user.selectOptions(
          screen.getByLabelText("Icon (optional)"),
          "receipt"
        )
      }
      await user.click(
        within(dialog).getByRole("button", { name: `Create ${noun}` })
      )
      expect(
        await screen.findByRole("heading", { name: "New Label" })
      ).toBeInTheDocument()
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      expect(
        fetcher.mock.calls.some(
          ([, options]) =>
            options?.method === "POST" &&
            String(options.body).includes('"name":"New Label"')
        )
      ).toBe(true)
      for (const key of [kind, "documents", "document"])
        expect(invalidate).toHaveBeenCalledWith({ queryKey: [key, profile.id] })
      expect(
        await screen.findByText(`Created ${noun} “New Label”.`)
      ).toBeInTheDocument()
    })
    it("validates blank and long names without submitting", async () => {
      const fetcher = setup(kind)
      const { user, dialog } = await create()
      await user.click(
        within(dialog).getByRole("button", { name: `Create ${noun}` })
      )
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "1 and 100"
      )
      await user.type(screen.getByLabelText("Name *"), "a".repeat(101))
      await user.click(
        within(dialog).getByRole("button", { name: `Create ${noun}` })
      )
      expect(
        fetcher.mock.calls.some(([, options]) => options?.method === "POST")
      ).toBe(false)
    })
    it("preserves data on duplicate-name conflict", async () => {
      setup(kind, (_url, options) =>
        options?.method === "POST" ? json({}, 409) : undefined
      )
      const { user, dialog } = await create()
      await user.type(screen.getByLabelText("Name *"), "Duplicate")
      await user.click(
        within(dialog).getByRole("button", { name: `Create ${noun}` })
      )
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "already have"
      )
      expect(screen.getByLabelText("Name *")).toHaveValue("Duplicate")
    })
    it("prepopulates, prevents unchanged edits, then renames", async () => {
      const fetcher = setup(kind),
        user = userEvent.setup()
      await user.click(
        await screen.findByRole("button", {
          name: `${kind === "categories" ? "Edit" : "Rename"} ${name}`,
        })
      )
      expect(screen.getByLabelText("Name *")).toHaveValue(name)
      expect(
        screen.getByRole("button", { name: "Save changes" })
      ).toBeDisabled()
      await user.type(screen.getByLabelText("Name *"), "   ")
      expect(
        screen.getByRole("button", { name: "Save changes" })
      ).toBeDisabled()
      await user.clear(screen.getByLabelText("Name *"))
      await user.type(screen.getByLabelText("Name *"), "Renamed")
      await user.click(screen.getByRole("button", { name: "Save changes" }))
      expect(
        await screen.findByRole("heading", { name: "Renamed" })
      ).toBeInTheDocument()
      expect(
        fetcher.mock.calls.some(
          ([url, options]) =>
            String(url).endsWith(`/${kind}/${id}`) &&
            options?.method === "PATCH"
        )
      ).toBe(true)
    })
    it("requires deletion confirmation, explains assignments, and refreshes the list", async () => {
      const fetcher = setup(kind)
      await screen.findByRole("heading", { name })
      const user = userEvent.setup()
      await user.click(screen.getByRole("button", { name: "Delete" }))
      const dialog = screen.getByRole("alertdialog")
      expect(dialog).toHaveTextContent(name)
      expect(dialog).toHaveTextContent(
        kind === "categories"
          ? "Deletion is blocked"
          : "documents themselves are kept"
      )
      expect(
        fetcher.mock.calls.some(([, options]) => options?.method === "DELETE")
      ).toBe(false)
      await user.click(
        within(dialog).getByRole("button", { name: "Confirm delete" })
      )
      expect(await screen.findByText(`No ${kind} yet`)).toBeInTheDocument()
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
      expect(screen.getByRole("status")).toHaveTextContent(
        "documents were not deleted"
      )
    })
    it("keeps failed deletion open with safe feedback", async () => {
      setup(kind, (_url, options) =>
        options?.method === "DELETE"
          ? json(
              { error: { message: "private database" } },
              kind === "categories" ? 409 : 503
            )
          : undefined
      )
      await screen.findByRole("heading", { name })
      const user = userEvent.setup()
      await user.click(screen.getByRole("button", { name: "Delete" }))
      await user.click(screen.getByRole("button", { name: "Confirm delete" }))
      expect(await screen.findByRole("alert")).not.toHaveTextContent(
        "private database"
      )
      if (kind === "categories")
        expect(screen.getByRole("alert")).toHaveTextContent("still assigned")
      expect(screen.getByRole("alertdialog")).toBeInTheDocument()
    })
    it("prevents duplicate creates while a request is pending", async () => {
      let finish!: (value: Response) => void
      const fetcher = setup(kind, (_url, options) =>
        options?.method === "POST"
          ? new Promise((resolve) => {
              finish = resolve
            })
          : undefined
      )
      const { user, dialog } = await create()
      await user.type(screen.getByLabelText("Name *"), "Pending")
      await user.dblClick(
        within(dialog).getByRole("button", { name: `Create ${noun}` })
      )
      expect(
        fetcher.mock.calls.filter(([, options]) => options?.method === "POST")
      ).toHaveLength(1)
      expect(
        within(dialog).getByRole("button", { name: `Create ${noun}` })
      ).toBeDisabled()
      await act(async () => finish(json({}, 503)))
      expect(await within(dialog).findByRole("alert")).toBeInTheDocument()
    })
    it("redirects an expired session on the new protected route", async () => {
      setup(kind, () => json({}, 401))
      await waitFor(() =>
        expect(navigation.replace).toHaveBeenCalledWith("/login")
      )
      expect(screen.queryByRole("heading", { name })).not.toBeInTheDocument()
    })
    it.each([403, 404])(
      "handles mutation HTTP %s without disclosing ownership",
      async (status) => {
        setup(kind, (_url, options) =>
          options?.method === "PATCH"
            ? json({ error: { message: "another user owns this" } }, status)
            : undefined
        )
        const user = userEvent.setup()
        await user.click(
          await screen.findByRole("button", {
            name: `${kind === "categories" ? "Edit" : "Rename"} ${name}`,
          })
        )
        await user.type(screen.getByLabelText("Name *"), " changed")
        await user.click(screen.getByRole("button", { name: "Save changes" }))
        expect(await screen.findByRole("alert")).not.toHaveTextContent(
          "another user"
        )
        expect(screen.getByRole("dialog")).toBeInTheDocument()
      }
    )
  }
)
