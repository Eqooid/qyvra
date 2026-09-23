import { Badge } from "@/components/ui/badge"

export function StatusBadge({
  status,
  children,
}: {
  status: string
  children?: React.ReactNode
}) {
  return (
    <Badge
      variant={status === "FAILED" ? "destructive" : "secondary"}
      className="h-auto max-w-full break-words whitespace-normal"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      {children ?? status.toLowerCase().replaceAll("_", " ")}
    </Badge>
  )
}
