import { z } from "zod"

export const profileFormSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "Enter your display name.")
    .max(100)
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Remove control characters."
    ),
  timezone: z
    .string()
    .max(100)
    .refine((value) => {
      if (value !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))
        return false
      try {
        new Intl.DateTimeFormat("en", { timeZone: value })
        return true
      } catch {
        return false
      }
    }, "Enter a supported timezone, such as Asia/Bangkok or UTC."),
  locale: z
    .string()
    .max(35)
    .refine((value) => {
      try {
        return (
          Intl.getCanonicalLocales(value)[0] === value &&
          Intl.DateTimeFormat.supportedLocalesOf([value]).length === 1
        )
      } catch {
        return false
      }
    }, "Enter a supported locale, such as en-US."),
})
// The configurable strength policy remains authoritative on the API.
export const passwordFormSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, "Enter your current password.")
      .max(2048),
    newPassword: z.string().min(1, "Enter a new password.").max(2048),
    confirmation: z.string().min(1, "Confirm your new password."),
  })
  .refine((value) => value.newPassword === value.confirmation, {
    path: ["confirmation"],
    message: "Passwords do not match.",
  })
