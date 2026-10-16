"use client"
import Link from "next/link"
import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { SourceExcerpt } from "@/features/ai/source-components"
import { useAuthApi, userKey } from "@/features/auth/provider"
import { getCitationSource } from "@/lib/api/ai"
import { ApiError } from "@/lib/api/client"
import {
  getLexicalSource,
  searchError,
  type SearchMatch,
  type SearchResult,
} from "@/lib/api/search"

export type SelectedSource = {
  result: SearchResult
  match: SearchMatch
  trigger: HTMLButtonElement
}
export function SearchSource({
  selected,
  owner,
  close,
}: {
  selected: SelectedSource
  owner: string
  close: () => void
}) {
  const api = useAuthApi(),
    cache = useQueryClient()
  const { result, match } = selected
  const [segment, setSegment] = useState(
    match.kind !== "chunk" ? (match.source?.segment ?? 0) : 0
  )
  const source = useQuery({
    queryKey: [
      "search-source",
      owner,
      result.documentId,
      result.documentVersionId,
      match,
      segment,
    ],
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        if (match.kind === "chunk")
          return {
            kind: "chunk" as const,
            value: await getCitationSource(
              api,
              result.documentId,
              result.documentVersionId,
              match.chunkId,
              signal
            ),
          }
        const reference = match.source
        if (
          !reference ||
          reference.documentId !== result.documentId ||
          reference.documentVersionId !== result.documentVersionId
        )
          throw new ApiError(404)
        return {
          kind: "page" as const,
          value: await getLexicalSource(api, { ...reference, segment }, signal),
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
        finalFocus={() => selected.trigger}
        className="w-full max-w-full overflow-y-auto sm:max-w-xl"
      >
        <SheetHeader>
          <SheetTitle>Document source</SheetTitle>
          <SheetDescription>
            Access is checked again. This is the exact version’s text, not a PDF
            preview.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          {source.isPending ? (
            <p role="status">Loading source…</p>
          ) : source.isError ? (
            <Alert role="alert">{searchError(source.error)}</Alert>
          ) : (
            <>
              <h2 className="text-lg font-medium break-words">
                {source.data.value.title}
              </h2>
              {source.data.kind === "chunk" ? (
                <SourceExcerpt source={source.data.value} />
              ) : (
                <>
                  <p>
                    Version {source.data.value.versionNumber} · Page{" "}
                    {source.data.value.pageNumber} · Part{" "}
                    {source.data.value.segment + 1}
                  </p>
                  <p className="text-sm break-words text-muted-foreground">
                    {source.data.value.originalFilename}
                  </p>
                  <blockquote
                    tabIndex={0}
                    className="max-h-[55svh] overflow-y-auto rounded-md border bg-muted/30 p-4 text-sm wrap-anywhere whitespace-pre-wrap"
                  >
                    {source.data.value.excerpt}
                  </blockquote>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={source.data.value.previousSegment === null}
                      onClick={() => {
                        if (
                          source.data?.kind === "page" &&
                          source.data.value.previousSegment !== null
                        )
                          setSegment(source.data.value.previousSegment)
                      }}
                    >
                      Previous part
                    </Button>
                    <Button
                      variant="outline"
                      disabled={source.data.value.nextSegment === null}
                      onClick={() => {
                        if (
                          source.data?.kind === "page" &&
                          source.data.value.nextSegment !== null
                        )
                          setSegment(source.data.value.nextSegment)
                      }}
                    >
                      Next part
                    </Button>
                  </div>
                </>
              )}
              <p className="text-sm text-muted-foreground">
                Historical file download and direct PDF page viewing are not
                available. Document details show the current document.
              </p>
              <Link
                href={`/documents/${result.documentId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                Document details (new tab)
              </Link>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
