import { test, expect } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { register, login, password } from "./auth"

test("login and category/tag tables work at mobile and desktop sizes in both themes", async ({
  page,
}) => {
  const token = randomUUID()
  const email = `ui-${token}@example.invalid`
  const secret = password()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/login")
  await expect(
    page.getByRole("heading", { name: "Welcome back" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Change theme" }).click()
  await page.getByRole("menuitemradio", { name: "Dark" }).click()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await register(page, email, secret)
  await page.getByRole("button", { name: "Account menu" }).click()
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await login(page, email, secret)

  for (const [route, noun] of [
    ["categories", "category"],
    ["tags", "tag"],
  ] as const) {
    await page.goto(`/${route}`)
    await page
      .getByRole("button", { name: `Create ${noun}`, exact: true })
      .click()
    await page.getByRole("dialog").getByLabel("Name *").fill(`${noun} ${token}`)
    await page
      .getByRole("dialog")
      .getByRole("button", { name: `Create ${noun}`, exact: true })
      .click()
    const table = page.getByRole("table")
    await expect(
      table.getByRole("columnheader", { name: "Name" })
    ).toBeVisible()
    await expect(
      table.getByRole("columnheader", { name: "Updated" })
    ).toBeVisible()
    await expect(
      table.getByRole("columnheader", { name: "Appearance" })
    ).toHaveCount(noun === "category" ? 1 : 0)
    const row = table
      .getByRole("row")
      .filter({ has: page.getByRole("heading", { name: `${noun} ${token}` }) })
    await expect(row).toBeVisible()
    for (const [width, theme] of [
      [390, "Dark"],
      [1440, "Light"],
    ] as const) {
      await page.setViewportSize({ width, height: 844 })
      await page.getByRole("button", { name: "Change theme" }).click()
      await page.getByRole("menuitemradio", { name: theme }).click()
      await expect(page.locator("html")).toHaveClass(
        new RegExp(theme.toLowerCase())
      )
      await expect(row).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true)
    }
    await row
      .getByRole("button", {
        name: `${noun === "category" ? "Edit" : "Rename"} ${noun} ${token}`,
      })
      .click()
    await page
      .getByRole("dialog")
      .getByLabel("Name *")
      .fill(`${noun} renamed ${token}`)
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save changes" })
      .click()
    const renamed = table.getByRole("row").filter({
      has: page.getByRole("heading", { name: `${noun} renamed ${token}` }),
    })
    await expect(renamed).toBeVisible()
    await renamed.getByRole("button", { name: "Delete" }).click()
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Confirm delete" })
      .click()
    await expect(
      page.getByRole("heading", { name: `No ${route} yet` })
    ).toBeVisible()
  }
})
