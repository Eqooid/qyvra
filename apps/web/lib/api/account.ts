import { z } from "zod"
import { AuthApi, profileSchema } from "./client"

export type ProfileUpdate = {
  displayName: string
  timezone: string
  locale: string
}
export function updateProfile(api: AuthApi, values: ProfileUpdate) {
  return api.mutate("/me", "PATCH", profileSchema, values)
}
export function logoutAll(api: AuthApi) {
  return api.mutate(
    "/auth/logout-all",
    "POST",
    z.object({ loggedOut: z.literal(true) })
  )
}
