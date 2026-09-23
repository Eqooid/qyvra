import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ThemeProvider } from "@/components/theme-provider"
import { ThemeToggle } from "@/components/theme-toggle"

let prefersDark = false
const listeners = new Set<(event: { matches: boolean }) => void>()

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ""
  prefersDark = false
  listeners.clear()
  vi.stubGlobal("matchMedia", () => ({
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    addListener: (listener: (event: { matches: boolean }) => void) =>
      listeners.add(listener),
    removeListener: (listener: (event: { matches: boolean }) => void) =>
      listeners.delete(listener),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
})

const mount = () =>
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>
  )

describe("theme menu", () => {
  it("ignores keydown events with missing or non-string keys", () => {
    mount()
    const onError = vi.fn()
    window.addEventListener("error", onError)
    try {
      for (const key of [undefined, null, 42]) {
        const event = new Event("keydown", { bubbles: true })
        if (key !== undefined)
          Object.defineProperty(event, "key", { value: key })
        fireEvent(window, event)
      }
      expect(onError).not.toHaveBeenCalled()
      expect(document.documentElement).toHaveClass("light")
      expect(localStorage.getItem("theme")).toBeNull()
    } finally {
      window.removeEventListener("error", onError)
    }
  })

  it("keeps the D shortcut while ignoring typing and modified keys", () => {
    render(
      <ThemeProvider>
        <input aria-label="Typing field" />
      </ThemeProvider>
    )
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "d" })
    fireEvent.keyDown(window, { key: "d", ctrlKey: true })
    expect(document.documentElement).toHaveClass("light")
    fireEvent.keyDown(window, { key: "D" })
    expect(document.documentElement).toHaveClass("dark")
    fireEvent.keyDown(window, { key: "d" })
    expect(document.documentElement).toHaveClass("light")
  })

  it("selects light and dark, indicates the selection, and restores it on remount", async () => {
    const user = userEvent.setup()
    const view = mount()
    for (const name of ["Dark", "Light", "Dark"]) {
      await user.click(screen.getByRole("button", { name: "Change theme" }))
      await user.click(await screen.findByRole("menuitemradio", { name }))
      await waitFor(() =>
        expect(document.documentElement).toHaveClass(name.toLowerCase())
      )
      expect(localStorage.getItem("theme")).toBe(name.toLowerCase())
      await waitFor(() =>
        expect(screen.queryByRole("menu")).not.toBeInTheDocument()
      )
    }
    view.unmount()
    mount()
    expect(document.documentElement).toHaveClass("dark")
    await user.click(screen.getByRole("button", { name: "Change theme" }))
    expect(
      await screen.findByRole("menuitemradio", { name: "Dark" })
    ).toHaveAttribute("aria-checked", "true")
  })

  it("follows operating system changes only while System is selected", async () => {
    const user = userEvent.setup()
    localStorage.setItem("theme", "dark")
    mount()
    await user.click(screen.getByRole("button", { name: "Change theme" }))
    await user.click(
      await screen.findByRole("menuitemradio", { name: "System" })
    )
    expect(localStorage.getItem("theme")).toBe("system")
    expect(document.documentElement).toHaveClass("light")
    act(() => {
      prefersDark = true
      listeners.forEach((listener) => listener({ matches: true }))
    })
    expect(document.documentElement).toHaveClass("dark")
    await user.click(screen.getByRole("button", { name: "Change theme" }))
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Light" })
    )
    act(() => listeners.forEach((listener) => listener({ matches: true })))
    expect(document.documentElement).toHaveClass("light")
  })

  it("supports keyboard selection and returns focus to the trigger", async () => {
    const user = userEvent.setup()
    mount()
    const trigger = screen.getByRole("button", { name: "Change theme" })
    trigger.focus()
    await user.keyboard("{ArrowDown}")
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: "Light" })).toHaveFocus()
    )
    await user.keyboard("{End}")
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemradio", { name: "System" })
      ).toHaveFocus()
    )
    await user.keyboard("{Enter}")
    await waitFor(() => expect(localStorage.getItem("theme")).toBe("system"))
    await waitFor(() => expect(trigger).toHaveFocus())
    await user.keyboard("{ArrowDown}{Escape}")
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    )
    expect(trigger).toHaveFocus()
  })
})
