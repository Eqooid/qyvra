import { describe, it, expect, vi } from "vitest"
import { apiBaseUrl, AuthApi } from "@/lib/api/client"
export const profile = {
  id: "13ee39cf-ed80-4d42-a7ec-a5df28c297d9",
  email: "owner@example.invalid",
  displayName: null,
  locale: "en",
  timezone: "UTC",
}
const response = (status: number, data: unknown = {}) =>
  new Response(
    JSON.stringify(
      status < 400 ? { data } : { error: { message: "private server details" } }
    ),
    { status }
  )
describe("authentication API", () => {
  it("calls browser fetch without binding it to the AuthApi instance", async () => {
    const fetcher: typeof fetch = function (this: unknown) {
      expect(this).toBeUndefined()
      return Promise.resolve(response(200, profile))
    }
    expect(await new AuthApi("/api/v1", fetcher).currentUser()).toEqual(profile)
  })
  it("validates the public base address and rejects embedded credentials", () => {
    expect(apiBaseUrl("https://api.example/api/v1/")).toBe(
      "https://api.example/api/v1"
    )
    expect(apiBaseUrl("")).toBe("/api/v1")
    for (const value of [
      "https://user:secret@api.example/api/v1",
      "javascript:bad",
      "//api.example",
      "https://api.example/api/v1?q=x",
    ])
      expect(() => apiBaseUrl(value)).toThrow()
  })
  it("shares one refresh for concurrent callers, then loads only the safe profile", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, { expiresAt: "later" }))
      .mockResolvedValueOnce(
        response(200, { ...profile, tokenHash: "should-not-escape" })
      )
    const api = new AuthApi("/api/v1", fetcher)
    expect(await Promise.all([api.currentUser(), api.currentUser()])).toEqual([
      profile,
      profile,
    ])
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/auth/me",
      "/api/v1/auth/refresh",
      "/api/v1/auth/me",
    ])
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "X-CSRF-Protection": "1" },
    })
    expect(fetcher.mock.calls[1][1]?.body).toBeUndefined()
  })
  it("serializes independent clients and rechecks before rotating again", async () => {
    let refreshed = false
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/refresh")) {
        refreshed = true
        return response(200, { expiresAt: "later" })
      }
      return refreshed ? response(200, profile) : response(401)
    })
    await Promise.all([
      new AuthApi("/api/v1", fetcher).currentUser(),
      new AuthApi("/api/v1", fetcher).currentUser(),
    ])
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/refresh"))
    ).toHaveLength(1)
  })
  it("returns no user after refresh is rejected, without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(401))
    expect(await new AuthApi("/api/v1", fetcher).currentUser()).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it("does not rotate on infrastructure failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(500))
    await expect(
      new AuthApi("/api/v1", fetcher).currentUser()
    ).rejects.toMatchObject({ status: 500 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("does not retry ambiguous refresh outcomes on a later check", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(401))
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce(response(401))
    const api = new AuthApi("/api/v1", fetcher)
    await expect(api.currentUser()).rejects.toMatchObject({ status: 0 })
    expect(await api.currentUser()).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it("requires login on expiry when cross-tab locking is unavailable", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(401))
    expect(await new AuthApi("/api/v1", fetcher).currentUser()).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("includes credentials and CSRF on logout without exposing server errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { loggedOut: true }))
      .mockResolvedValueOnce(response(409))
    const api = new AuthApi("/api/v1", fetcher)
    await api.logout()
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "X-CSRF-Protection": "1" },
    })
    await expect(
      api.register("a@example.invalid", "test password")
    ).rejects.not.toThrow("private server details")
  })
})
