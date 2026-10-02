import { VersionHistory } from "@/features/documents/version-history"
import { uploadLimit } from "@/features/documents/upload-validation"
export const metadata = { title: "Version history | QYVRA" }
export default async function VersionsPage({
  params,
}: {
  params: Promise<{ documentId: string }>
}) {
  const { documentId } = await params
  return (
    <VersionHistory
      key={documentId}
      documentId={documentId}
      maxBytes={uploadLimit()}
    />
  )
}
