import { z } from "zod"
export const normalizeName = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ")
export const organizationFormSchema = z.object({
  name: z
    .string()
    .transform(normalizeName)
    .refine(
      (value) => [...value].length >= 1 && [...value].length <= 100,
      "Use a name between 1 and 100 characters."
    )
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/u.test(value),
      "Control characters are not allowed."
    ),
  color: z
    .string()
    .refine(
      (value) => value === "" || /^#[0-9a-f]{6}$/i.test(value),
      "Choose a six-digit hex color."
    ),
  icon: z
    .string()
    .refine(
      (value) =>
        value === "" ||
        (value.length <= 50 && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(value)),
      "Choose a valid icon."
    ),
})
export type OrganizationValues = z.infer<typeof organizationFormSchema>
export const colorOptions = [
  { value: "#c2410c", label: "Orange" },
  { value: "#2563eb", label: "Blue" },
  { value: "#15803d", label: "Green" },
  { value: "#7c3aed", label: "Purple" },
  { value: "#be185d", label: "Pink" },
  { value: "#64748b", label: "Slate" },
]
