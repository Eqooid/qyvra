import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AuthProvider } from "@/features/auth/provider"
import { AuthForm } from "@/features/auth/auth-form"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { focusManager } from "@tanstack/react-query"
import { act } from "@testing-library/react"
const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  path: "/login",
}))
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  usePathname: () => navigation.path,
}))
const profile = {
  id: "13ee39cf-ed80-4d42-a7ec-a5df28c297d9",
  email: "owner@example.invalid",
  displayName: "Alex",
  locale: "en",
  timezone: "UTC",
}
const response = (status: number, data: unknown = {}) =>
  new Response(JSON.stringify({ data }), { status })
beforeEach(() => {
  navigation.path = "/login"
  navigation.replace.mockReset()
  navigation.refresh.mockReset()
})
const form = (mode: "login" | "register" = "login") =>
  render(
    <AuthProvider>
      <AuthForm mode={mode} />
    </AuthProvider>
  )
const dashboard = () => {
  navigation.path = "/dashboard"
  return render(
    <AuthProvider>
      <DashboardShell>
        <p>Dashboard content</p>
      </DashboardShell>
    </AuthProvider>
  )
}
async function fill() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText("Email address"), profile.email)
  await user.type(screen.getByLabelText("Password"), "a long test passphrase")
  return user
}
describe("authentication components with the real API client", () => {
  it("redirects when a previously valid session expires on a focus check", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(200, profile))
      .mockImplementation(() => Promise.resolve(response(401)))
    vi.stubGlobal("fetch", fetcher)
    dashboard()
    expect(await screen.findByText(profile.email)).toBeInTheDocument()
    expect(screen.getByText("QYVRA", { exact: true })).toBeInTheDocument()
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/login")
    )
    expect(screen.queryByText("Dashboard content")).not.toBeInTheDocument()
  })
  it("prevents duplicate submissions while login is pending", async () => {
    let complete!: (value: Response) => void
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve
        })
    )
    vi.stubGlobal("fetch", fetcher)
    form()
    expect(screen.getByText("Log in to QYVRA.")).toBeInTheDocument()
    const user = await fill()
    await user.click(screen.getByRole("button", { name: "Log in" }))
    expect(screen.getByRole("button", { name: "Please wait…" })).toBeDisabled()
    expect(screen.getByLabelText("Password")).toBeDisabled()
    await act(async () => {
      complete(response(200, { user: profile, expiresAt: "later" }))
    })
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/dashboard")
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("validates required fields before sending requests", async () => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    form()
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))
    expect(await screen.findByText("Enter your password.")).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("logs in using cookies, clears the password and navigates to dashboard", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response(200, { user: profile, expiresAt: "later" }))
    vi.stubGlobal("fetch", fetcher)
    form()
    const user = await fill()
    await user.click(screen.getByRole("button", { name: "Log in" }))
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/dashboard")
    )
    expect(fetcher.mock.calls[0][1].credentials).toBe("include")
    expect(screen.getByLabelText("Password")).toHaveValue("")
  })
  it("registration asks for a separate login and creates no session", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(201, profile))
    vi.stubGlobal("fetch", fetcher)
    form("register")
    const user = await fill()
    await user.click(screen.getByRole("button", { name: "Create account" }))
    expect(
      await screen.findByRole("link", { name: "Continue to login" })
    ).toHaveAttribute("href", "/login")
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(navigation.replace).not.toHaveBeenCalled()
  })
  it.each([401, 409, 429, 500])(
    "shows a safe error for HTTP %s",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)))
      form(status === 409 ? "register" : "login")
      const user = await fill()
      await user.click(
        screen.getByRole("button", {
          name: status === 409 ? "Create account" : "Log in",
        })
      )
      expect(await screen.findByRole("alert")).toBeInTheDocument()
      expect(navigation.replace).not.toHaveBeenCalled()
    }
  )
  it("hides protected content while loading and redirects expired authentication", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401)))
    dashboard()
    expect(screen.queryByText("Dashboard content")).not.toBeInTheDocument()
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/login")
    )
  })
  it("renders the owner, toggles mobile navigation, and logs out", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(200, profile))
      .mockResolvedValueOnce(response(200, { loggedOut: true }))
    vi.stubGlobal("fetch", fetcher)
    window.innerWidth = 375
    dashboard()
    expect(await screen.findByText(profile.email)).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("button", { name: "Open navigation" })
    )
    expect(
      screen.getByRole("navigation", { name: "Mobile navigation" })
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("button", { name: "Close navigation" })
    )
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Log out" })
    )
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/login")
    )
    expect(fetcher.mock.calls[1][1].headers).toMatchObject({
      "X-CSRF-Protection": "1",
    })
  })
  it("shows recoverable connection errors instead of private content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    dashboard()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to reach the API"
    )
    expect(screen.queryByText("Dashboard content")).not.toBeInTheDocument()
    expect(navigation.replace).not.toHaveBeenCalled()
  })
})

it("reveals the password without submitting or changing its value", async () => {
  const fetcher = vi.fn()
  vi.stubGlobal("fetch", fetcher)
  form()
  const user = await fill()
  await user.click(screen.getByRole("button", { name: "Show password" }))
  expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text")
  expect(screen.getByLabelText("Password")).toHaveValue(
    "a long test passphrase"
  )
  await user.click(screen.getByRole("button", { name: "Hide password" }))
  expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password")
  expect(fetcher).not.toHaveBeenCalled()
})
it("highlights nested document navigation and collapses with button and keyboard", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(200, profile)))
  navigation.path = "/documents/upload"
  render(
    <AuthProvider>
      <DashboardShell>
        <p>Upload content</p>
      </DashboardShell>
    </AuthProvider>
  )
  expect(
    await screen.findByRole("link", { name: "Documents" })
  ).toHaveAttribute("aria-current", "location")
  expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
    "data-active"
  )
  const user = userEvent.setup()
  const trigger = screen.getByRole("button", { name: "Toggle sidebar" })
  await user.click(trigger)
  expect(trigger).toHaveAttribute("aria-expanded", "false")
  await user.keyboard("{Control>}b{/Control}")
  expect(trigger).toHaveAttribute("aria-expanded", "true")
})
it("opens the mobile sidebar and restores trigger focus after Escape", async () => {
  window.innerWidth = 375
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(200, profile)))
  dashboard()
  const trigger = await screen.findByRole("button", { name: "Open navigation" })
  const user = userEvent.setup()
  await user.click(trigger)
  const dialog = screen.getByRole("dialog")
  await waitFor(() =>
    expect(dialog.contains(document.activeElement)).toBe(true)
  )
  await user.keyboard("{Escape}")
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  )
  expect(trigger).toHaveFocus()
  await user.click(trigger)
  const documentsLink = screen.getByRole("link", { name: "Documents" })
  // Next navigation is mocked here; exercise dismissal without jsdom navigation.
  documentsLink.addEventListener("click", (event) => event.preventDefault(), {
    once: true,
  })
  await user.click(documentsLink)
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  )
})
