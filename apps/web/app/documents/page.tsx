import { Suspense } from "react"
import { DocumentsList } from "@/features/documents/documents-list"
import { LoadingPanel } from "@/components/shared/loading-panel"
export default function DocumentsPage() {
  return (
    <Suspense fallback={<LoadingPanel label="Loading documents…" />}>
      <DocumentsList />
    </Suspense>
  )
}
