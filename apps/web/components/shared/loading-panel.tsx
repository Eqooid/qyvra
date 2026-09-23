import { Skeleton } from "@/components/ui/skeleton"
import { Card } from "@/components/ui/card"
export function LoadingPanel({ label }: { label: string }) {
  return (
    <Card className="space-y-5 p-6">
      <p role="status" className="text-sm text-muted-foreground">
        {label}
      </p>
      <div aria-hidden className="space-y-4">
        <Skeleton className="h-5 w-2/5 rounded bg-muted" />
        <Skeleton className="h-3 w-3/4 rounded bg-muted" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-16 rounded-lg bg-muted" />
          <Skeleton className="h-16 rounded-lg bg-muted" />
        </div>
      </div>
    </Card>
  )
}
