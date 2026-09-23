import { expect, it, vi } from "vitest"
import { AuthApi, ApiError } from "@/lib/api/client"
import { saveOrganization, deleteOrganization } from "@/lib/api/organization"
import { organizationFormSchema } from "@/features/organization/validation"
import { id, category, tag, json } from "./documents.fixture"
it.each(["categories", "tags"] as const)(
  "%s mutations use exact routes, safe bodies, credentials and CSRF",
  async (kind) => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        json({ data: kind === "categories" ? category : tag })
      )
    const api = new AuthApi("/api/v1", fetcher)
    await saveOrganization(api, kind, {
      name: "Finance",
      color: null,
      icon: null,
      ...{ userId: "forged" },
    })
    expect(fetcher.mock.calls[0]).toEqual([
      `/api/v1/${kind}`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "X-CSRF-Protection": "1" }),
        body: JSON.stringify(
          kind === "categories"
            ? { name: "Finance", color: null, icon: null }
            : { name: "Finance" }
        ),
      }),
    ])
    await saveOrganization(api, kind, { name: "Renamed" }, id)
    expect(fetcher.mock.calls[1][0]).toBe(`/api/v1/${kind}/${id}`)
    expect(fetcher.mock.calls[1][1].method).toBe("PATCH")
    fetcher.mockResolvedValue(json({ data: { deleted: true } }))
    await deleteOrganization(api, kind, id)
    expect(fetcher.mock.calls[2][1].method).toBe("DELETE")
    expect(fetcher.mock.calls[2][1].body).toBeUndefined()
    expect(() => deleteOrganization(api, kind, "../foreign")).toThrow(ApiError)
  }
)
it("normalizes display names, counts Unicode characters and rejects unsafe fields", () => {
  const parse = (name: string) =>
    organizationFormSchema.safeParse({ name, color: "", icon: "" })
  expect(
    organizationFormSchema.parse({
      name: "  Ｆｉｎａｎｃｅ   Records  ",
      color: "",
      icon: "",
    }).name
  ).toBe("Finance Records")
  expect(parse(" ").success).toBe(false)
  expect(parse("a".repeat(101)).success).toBe(false)
  expect(parse("😀".repeat(100)).success).toBe(true)
  expect(parse("bad\u0000name").success).toBe(false)
  expect(
    organizationFormSchema.safeParse({
      name: "Fine",
      color: "bg-red-500",
      icon: "<svg>",
    }).success
  ).toBe(false)
})
