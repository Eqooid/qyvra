import { CitationSourcePage } from "@/features/ai/source-components"
export const metadata = { title: "Document source | QYVRA" }
export default async function Page({
  params,
}: {
  params: Promise<{ documentId: string; versionId: string; chunkId: string }>
}) {
  const ids = await params
  return (
    <CitationSourcePage
      key={`${ids.documentId}/${ids.versionId}/${ids.chunkId}`}
      {...ids}
    />
  )
}
