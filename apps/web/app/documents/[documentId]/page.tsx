import { DocumentDetailPage } from "@/features/documents/document-detail"
export const metadata = { title: "Document | QYVRA" }
export default async function Page({
  params,
}: {
  params: Promise<{ documentId: string }>
}) {
  const { documentId } = await params
  return <DocumentDetailPage key={documentId} documentId={documentId} />
}
