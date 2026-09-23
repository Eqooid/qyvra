import { z } from "zod"

export function uploadLimit(value = process.env.NEXT_PUBLIC_UPLOAD_MAX_BYTES) {
  if (!value) return 50 * 1024 * 1024
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(+value) ||
    +value < 1 ||
    +value > 200 * 1024 * 1024
  )
    throw new Error(
      "NEXT_PUBLIC_UPLOAD_MAX_BYTES must be an integer between 1 and 209715200."
    )
  return +value
}
export function fileError(file: File | undefined, max: number) {
  if (!file) return "Choose one file."
  if (file.name.length > 255) return "Filename must be at most 255 characters."
  if (!/\.(pdf|jpe?g|png)$/i.test(file.name))
    return "Choose a PDF, JPEG or PNG file."
  if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type))
    return "The browser must identify the file as PDF, JPEG or PNG."
  if (!file.size) return "The file is empty."
  if (file.size > max)
    return `File exceeds the ${formatBytes(max)} upload limit.`
}
export function formatBytes(bytes: number) {
  return bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Control characters are not allowed."
    )
const date = z
  .string()
  .refine(
    (value) =>
      !value ||
      (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !value.startsWith("0000") &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value),
    "Enter a valid date."
  )
export const uploadFormSchema = z
  .object({
    title: text(300).refine((value) => value.length > 0, "Enter a title."),
    documentType: z
      .string()
      .trim()
      .regex(
        /^[A-Z][A-Z0-9_]{0,49}$/,
        "Use an uppercase type, such as INVOICE or OTHER."
      ),
    issuer: text(200),
    referenceNumber: text(200),
    documentDate: date,
    expirationDate: date,
    categoryId: z.union([z.literal(""), z.string().uuid()]),
    tagIds: z.array(z.string().uuid()).max(100),
  })
  .refine(
    (value) =>
      !value.documentDate ||
      !value.expirationDate ||
      value.expirationDate >= value.documentDate,
    {
      path: ["expirationDate"],
      message: "Expiration cannot be earlier than the document date.",
    }
  )
