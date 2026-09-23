import { beforeEach, expect, it, vi } from "vitest"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AuthProvider } from "@/features/auth/provider"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { AccountSettings } from "@/features/account/account-settings"
import {
  profileFormSchema,
  passwordFormSchema,
} from "@/features/account/validation"
const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  usePathname: () => "/settings",
}))
const profile = {
  id: "13ee39cf-ed80-4d42-a7ec-a5df28c297d9",
  email: "account@example.invalid",
  displayName: "Alex",
  timezone: "UTC",
  locale: "en",
}
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status })
beforeEach(() => {
  vi.clearAllMocks()
})
function mount() {
  render(
    <AuthProvider>
      <DashboardShell>
        <AccountSettings />
      </DashboardShell>
    </AuthProvider>
  )
}
it("loads profile, saves only supported fields with credentials/CSRF and updates the header", async () => {
  const fetcher = vi.fn(async (_url: string, options: RequestInit) =>
    reply(
      options.method === "PATCH"
        ? { ...profile, displayName: "Updated" }
        : profile
    )
  )
  vi.stubGlobal("fetch", fetcher)
  mount()
  const user = userEvent.setup()
  await user.clear(await screen.findByLabelText("Display name"))
  await user.type(screen.getByLabelText("Display name"), "Updated")
  await user.click(screen.getByRole("button", { name: "Save profile" }))
  expect(await screen.findByText("Profile saved.")).toBeInTheDocument()
  expect(
    screen.getByRole("button", { name: "Account menu" })
  ).toHaveTextContent("Updated")
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining("/me"),
    expect.objectContaining({
      method: "PATCH",
      credentials: "include",
      headers: expect.objectContaining({ "X-CSRF-Protection": "1" }),
      body: JSON.stringify({
        displayName: "Updated",
        timezone: "UTC",
        locale: "en",
      }),
    })
  )
  expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled()
})
it("validates profile fields and password confirmation", () => {
  for (const invalid of [
    { displayName: " " },
    { timezone: "+07:00" },
    { locale: "not_a_locale" },
  ])
    expect(
      profileFormSchema.safeParse({
        displayName: "Alex",
        timezone: "UTC",
        locale: "en",
        ...invalid,
      }).success
    ).toBe(false)
  expect(
    passwordFormSchema.safeParse({
      currentPassword: "old",
      newPassword: "new",
      confirmation: "different",
    }).success
  ).toBe(false)
})
async function passwords() {
  const user = userEvent.setup()
  await user.type(
    await screen.findByLabelText("Current password"),
    "old long test password"
  )
  await user.type(
    screen.getByLabelText("New password", { exact: true }),
    "new long test password"
  )
  await user.type(
    screen.getByLabelText("Confirm new password"),
    "new long test password"
  )
  await user.click(screen.getByRole("button", { name: "Change password" }))
  return user
}
it("sends only the two password fields once and clears them after success", async () => {
  const fetcher = vi.fn(async (url: string) =>
    reply(url.endsWith("/password") ? { passwordChanged: true } : profile)
  )
  vi.stubGlobal("fetch", fetcher)
  mount()
  await passwords()
  expect(await screen.findByText(/Password changed\./)).toBeInTheDocument()
  expect(screen.getByLabelText("Current password")).toHaveValue("")
  expect(screen.getByLabelText("Confirm new password")).toHaveValue("")
  const calls = fetcher.mock.calls.filter(([url]) => url.endsWith("/password"))
  expect(calls).toHaveLength(1)
  expect(navigation.replace).not.toHaveBeenCalled()
})
it("does not retry an incorrect current password or log out a valid session", async () => {
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith("/password") ? reply({}, 401) : reply(profile)
  )
  vi.stubGlobal("fetch", fetcher)
  mount()
  await passwords()
  expect(
    await screen.findByText("Unable to verify your current password.")
  ).toBeInTheDocument()
  expect(
    fetcher.mock.calls.filter(([url]) => url.endsWith("/password"))
  ).toHaveLength(1)
  expect(navigation.replace).not.toHaveBeenCalled()
})
it("requires confirmation, calls logout-all and clears protected content", async () => {
  let revoked = false
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith("logout-all")
      ? ((revoked = true), reply({ loggedOut: true }))
      : reply(profile, revoked ? 401 : 200)
  )
  vi.stubGlobal("fetch", fetcher)
  mount()
  await userEvent.click(
    await screen.findByRole("button", { name: "Log out of all sessions" })
  )
  const dialog = await screen.findByRole("alertdialog")
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("logout-all"))).toBe(
    false
  )
  await userEvent.click(
    within(dialog).getByRole("button", {
      name: "Confirm log out of all sessions",
    })
  )
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login"))
  await waitFor(() =>
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument()
  )
})

it("prevents duplicate profile submissions and preserves input on failure", async () => {
  let complete!: (value: Response) => void
  const fetcher = vi.fn(async (_url: string, options: RequestInit) =>
    options.method === "PATCH"
      ? new Promise<Response>((resolve) => {
          complete = resolve
        })
      : reply(profile)
  )
  vi.stubGlobal("fetch", fetcher)
  mount()
  const user = userEvent.setup()
  await user.clear(await screen.findByLabelText("Display name"))
  await user.type(screen.getByLabelText("Display name"), "Pending name")
  await user.dblClick(screen.getByRole("button", { name: "Save profile" }))
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled()
  expect(
    fetcher.mock.calls.filter(([, options]) => options.method === "PATCH")
  ).toHaveLength(1)
  await act(async () => complete(reply({}, 503)))
  expect(
    await screen.findByText(
      "The request could not be completed. Please try again."
    )
  ).toBeInTheDocument()
  expect(screen.getByLabelText("Display name")).toHaveValue("Pending name")
})
it("keeps logout-all confirmation open on server failure and permits retry", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("logout-all") ? reply({}, 503) : reply(profile)
    )
  )
  mount()
  await userEvent.click(
    await screen.findByRole("button", { name: "Log out of all sessions" })
  )
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm log out of all sessions" })
  )
  expect(
    await screen.findByText(
      "The request could not be completed. Please try again."
    )
  ).toBeInTheDocument()
  expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  expect(
    screen.getByRole("button", { name: "Confirm log out of all sessions" })
  ).toBeEnabled()
  expect(navigation.replace).not.toHaveBeenCalled()
})
it("never renders settings for a missing session", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reply({}, 401))
  )
  mount()
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login"))
  expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument()
})
