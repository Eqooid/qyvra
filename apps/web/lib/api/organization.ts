import { z } from "zod"
import { ApiError, AuthApi } from "./client"
import { categorySchema, tagSchema } from "./documents"
export type OrganizationKind = "categories" | "tags"
export type OrganizationItem = z.infer<typeof tagSchema> & {
  color?: string | null
  icon?: string | null
}
export type OrganizationInput = {
  name: string
  color?: string | null
  icon?: string | null
}
function target(kind: OrganizationKind, id?: string) {
  if (id !== undefined && !z.string().uuid().safeParse(id).success)
    throw new ApiError(404)
  return `/${kind}${id ? `/${id}` : ""}`
}
export function saveOrganization(
  api: AuthApi,
  kind: OrganizationKind,
  input: OrganizationInput,
  id?: string
) {
  const body: OrganizationInput = { name: input.name }
  if (kind === "categories") {
    if (input.color !== undefined) body.color = input.color
    if (input.icon !== undefined) body.icon = input.icon
  }
  return api.mutate<OrganizationItem>(
    target(kind, id),
    id ? "PATCH" : "POST",
    kind === "categories" ? categorySchema : tagSchema,
    body
  )
}
export function deleteOrganization(
  api: AuthApi,
  kind: OrganizationKind,
  id: string
) {
  return api.mutate(
    target(kind, id),
    "DELETE",
    z.object({ deleted: z.literal(true) })
  )
}
export function organizationError(
  error: unknown,
  kind: OrganizationKind,
  deleting = false
) {
  const noun = kind === "categories" ? "category" : "tag"
  if (!(error instanceof ApiError))
    return "The request could not be confirmed. Refresh the list before trying again."
  switch (error.status) {
    case 400:
      return "Check the name and optional styling, then try again."
    case 403:
      return "This request is not permitted. Check your access or contact the application owner."
    case 404:
      return `This ${noun} is no longer available. Refresh the list.`
    case 409:
      return deleting && kind === "categories"
        ? "This category is still assigned to a document, possibly a soft-deleted document. It cannot be deleted while referenced."
        : `You already have a ${noun} with that name. Choose a different name; capitalization alone does not make it unique.`
    default:
      return error.message
  }
}
