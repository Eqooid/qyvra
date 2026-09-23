import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { Card } from "@/components/ui/card"
import Link from "next/link"
import { FolderOpen, Upload, ArrowUpRight } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
export default function DashboardPage() {
  return (
    <Card className="flex min-h-80 flex-col items-center justify-center rounded-2xl border bg-card p-6 text-center shadow-sm sm:p-10">
      <Empty>
        <div className="mb-5 rounded-2xl bg-primary/10 p-4 text-primary">
          <FolderOpen size={28} aria-hidden />
        </div>
        <EmptyHeader>
          <EmptyTitle>
            <h2 className="text-xl font-semibold tracking-tight">
              Your workspace is ready
            </h2>
          </EmptyTitle>
        </EmptyHeader>
        <EmptyDescription className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Keep your important records together. Add a document or pick up where
          you left off in your collection.
        </EmptyDescription>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/documents/upload" className={buttonVariants()}>
            <Upload aria-hidden />
            Upload document
          </Link>
          <Link
            href="/documents"
            className={buttonVariants({ variant: "outline" })}
          >
            Browse documents
            <ArrowUpRight aria-hidden />
          </Link>
        </div>
      </Empty>
    </Card>
  )
}
