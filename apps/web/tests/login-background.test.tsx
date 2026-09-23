import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { AnimatedLoginBackground } from "@/components/auth/animated-login-background"

const route = vi.hoisted(() => ({ pathname: "/login" }))
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }))

const context = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  strokeStyle: "",
  fillStyle: "",
  globalAlpha: 1,
  lineWidth: 1,
  shadowColor: "",
  shadowBlur: 0,
}

beforeEach(() => {
  route.pathname = "/login"
  vi.clearAllMocks()
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  )
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600)
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1)
  )
  vi.stubGlobal("cancelAnimationFrame", vi.fn())
})

describe("login network background", () => {
  it("draws behind the login form without receiving input and cleans up", () => {
    const { container, unmount } = render(<AnimatedLoginBackground />)
    const canvas = container.querySelector("canvas")
    expect(canvas).toBeInTheDocument()
    expect(canvas?.parentElement).toHaveAttribute("aria-hidden", "true")
    expect(canvas?.parentElement).toHaveClass("pointer-events-none")
    expect(canvas).toHaveAttribute("width", "800")
    expect(context.arc).toHaveBeenCalled()
    expect(requestAnimationFrame).toHaveBeenCalled()
    unmount()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
  })

  it("does not mount on the registration route", () => {
    route.pathname = "/register"
    render(<AnimatedLoginBackground />)
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
    expect(document.querySelector("canvas")).not.toBeInTheDocument()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it("keeps a static network under reduced motion and redraws after a theme change", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    render(<AnimatedLoginBackground />)
    expect(context.arc).toHaveBeenCalled()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    const draws = context.clearRect.mock.calls.length
    document.documentElement.classList.add("dark")
    await waitFor(() =>
      expect(context.clearRect.mock.calls.length).toBeGreaterThan(draws)
    )
    document.documentElement.classList.remove("dark")
  })
})
