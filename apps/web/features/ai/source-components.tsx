"use client"
import Link from "next/link"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Alert } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { buttonVariants } from "@/components/ui/button"
import { useAuthApi, useCurrentUser, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import {
  aiError,
  getCitationSource,
  sourcePath,
  type Citation,
  type CitationSource,
  type SemanticResult,
} from "@/lib/api/ai"

export function sourcePages(source: Pick<CitationSource, "pageSpans">) {
  const pages = [...new Set(source.pageSpans.map((p) => p.pageNumber))]
  return pages.length === 1 ? `Page ${pages[0]}` : `Pages ${pages.join(", ")}`
}
export function SourceExcerpt({ source }: { source: CitationSource }) {
  return (
    <section aria-label="Source excerpt" className="min-w-0 space-y-3">
      <p className="text-sm text-muted-foreground">
        Version {source.versionNumber} · {sourcePages(source)}
      </p>
      <p className="text-sm break-words text-muted-foreground">
        {source.originalFilename}
      </p>
      <blockquote
        className="max-h-[55svh] overflow-y-auto rounded-md border bg-muted/30 p-4 text-sm wrap-anywhere whitespace-pre-wrap"
        tabIndex={0}
      >
        {source.excerpt}
      </blockquote>
    </section>
  )
}
export function CitationSheet({
  citation,
  trigger,
  close,
  owner,
}: {
  citation: Citation
  trigger: HTMLButtonElement
  close: () => void
  owner: string
}) {
  const api = useAuthApi(),
    cache = useQueryClient()
  const source = useQuery({
    queryKey: [
      "citation-source",
      owner,
      citation.documentId,
      citation.documentVersionId,
      citation.chunkId,
    ],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        const value = await getCitationSource(
          api,
          citation.documentId,
          citation.documentVersionId,
          citation.chunkId,
          signal
        )
        const start = citation.excerptStart - value.excerptStart
        const end = citation.excerptEnd - value.excerptStart
        const spans = value.pageSpans
          .map((span) => ({
            ...span,
            startOffset: Math.max(span.startOffset, citation.excerptStart),
            endOffset: Math.min(span.endOffset, citation.excerptEnd),
          }))
          .filter((span) => span.endOffset > span.startOffset)
        if (
          start < 0 ||
          end > Array.from(value.excerpt).length ||
          Array.from(value.excerpt).slice(start, end).join("") !==
            citation.excerpt ||
          JSON.stringify(spans) !== JSON.stringify(citation.pageSpans)
        )
          throw new ApiError(404)
        return {
          ...value,
          excerpt: citation.excerpt,
          excerptStart: citation.excerptStart,
          excerptEnd: citation.excerptEnd,
          excerptHash: citation.excerptHash,
          pageSpans: spans,
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401)
          cache.setQueryData(userKey, null)
        throw error
      }
    },
  })
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <SheetContent
        finalFocus={() => trigger}
        className="w-full max-w-full overflow-y-auto sm:max-w-lg"
      >
        <SheetHeader>
          <SheetTitle>Source {citation.citationId}</SheetTitle>
          <SheetDescription>
            Access is checked again before showing this source.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          {source.isPending ? (
            <div role="status" aria-label="Loading source">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="mt-4 h-32 w-full" />
            </div>
          ) : source.isError ? (
            <Alert role="alert">{aiError(source.error)}</Alert>
          ) : (
            <>
              <h3 className="text-lg font-medium break-words">
                {source.data.title}
              </h3>
              <SourceExcerpt source={source.data} />
              <Link
                href={sourcePath(source.data)}
                className={buttonVariants({ variant: "outline" })}
              >
                Open source
              </Link>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
export function SemanticResultCard({ result }: { result: SemanticResult }) {
  return (
    <article className="min-w-0 space-y-3 rounded-lg border bg-card p-4">
      <h3 className="font-medium break-words">{result.title}</h3>
      <p className="text-sm text-muted-foreground">
        Version {result.versionNumber} · {sourcePages(result)}
      </p>
      <p className="line-clamp-6 text-sm wrap-anywhere whitespace-pre-wrap">
        {result.excerpt}
      </p>
      <Link
        href={sourcePath(result)}
        className="inline-block rounded text-sm text-primary underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        View source
      </Link>
    </article>
  )
}
export function CitationSourcePage({
  documentId,
  versionId,
  chunkId,
}: {
  documentId: string
  versionId: string
  chunkId: string
}) {
  const api = useAuthApi(),
    user = useCurrentUser(),
    cache = useQueryClient()
  const source = useQuery({
    queryKey: [
      "citation-source",
      user.data?.id,
      documentId,
      versionId,
      chunkId,
    ],
    enabled: !!user.data,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return await getCitationSource(
          api,
          documentId,
          versionId,
          chunkId,
          signal
        )
      } catch (error) {
        if (error instanceof ApiError && error.status === 401)
          cache.setQueryData(userKey, null)
        throw error
      }
    },
  })
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/ai" className="text-sm text-primary underline">
        Back to AI Search
      </Link>
      <h1 className="text-2xl font-semibold">Document source</h1>
      {source.isPending ? (
        <p role="status">Loading source…</p>
      ) : source.isError ? (
        <Alert role="alert">{aiError(source.error)}</Alert>
      ) : (
        <>
          <h2 className="text-xl font-medium break-words">
            {source.data.title}
          </h2>
          <SourceExcerpt source={source.data} />
          <p className="text-sm text-muted-foreground">
            This is the cited version’s canonical text excerpt. Historical file
            download and direct PDF page viewing are not available.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link
              href={`/documents/${source.data.documentId}`}
              className="text-primary underline"
            >
              Document details
            </Link>
            <Link
              href={`/documents/${source.data.documentId}/versions`}
              className="text-primary underline"
            >
              Version history
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
