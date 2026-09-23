import { expect, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
export const password = () => `E2E-pass-${randomUUID()}!`
export async function login(page: Page, email: string, secret: string) {
  await page.goto("/login")
  await page.getByLabel("Email address").fill(email)
  await page.getByLabel("Password", { exact: true }).fill(secret)
  await page.getByRole("button", { name: "Log in", exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}
export async function register(page: Page, email: string, secret: string) {
  await page.goto("/register")
  await page.getByLabel("Email address").fill(email)
  await page.getByLabel("Password", { exact: true }).fill(secret)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect(
    page.getByRole("heading", { name: "Your account is ready" })
  ).toBeVisible()
  await login(page, email, secret)
}
