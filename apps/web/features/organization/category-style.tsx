import {
  FolderOpen,
  FileText,
  Receipt,
  Briefcase,
  Heart,
  House,
} from "lucide-react"
export const iconOptions = {
  "folder-open": FolderOpen,
  "file-text": FileText,
  receipt: Receipt,
  briefcase: Briefcase,
  heart: Heart,
  house: House,
}
export function CategoryStyle({
  color,
  icon,
}: {
  color?: string | null
  icon?: string | null
}) {
  const safeColor = color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined
  const Icon =
    icon && Object.hasOwn(iconOptions, icon)
      ? iconOptions[icon as keyof typeof iconOptions]
      : FolderOpen
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="break-all">{icon || "Default icon"}</span>
      {safeColor && (
        <>
          <span
            aria-hidden
            className="size-3 rounded-full border"
            style={{ backgroundColor: safeColor }}
          />
          <span>{safeColor}</span>
        </>
      )}
    </div>
  )
}
