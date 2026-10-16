"use client"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useAuthApi, useCurrentUser, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import {
  searchDocuments,
  searchError,
  searchRequestSchema,
  type SearchMode,
  type SearchFilters,
  type SearchResponse,
} from "@/lib/api/search"
import { Button } from "@/components/ui/button"
import { Alert } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { DocumentFilterSelect } from "@/features/documents/document-filter-select"
import { SearchInput } from "./autocomplete"
import { SearchFiltersDialog } from "./search-filters"
import { SafeHighlight } from "./safe-highlight"
import { SearchSource, type SelectedSource } from "./search-source"

type Draft = {
  query: string
  mode: SearchMode
  filters: SearchFilters
  match: "terms" | "phrase"
}
const empty = (): Draft => ({
  query: "",
  mode: "keyword",
  filters: {},
  match: "terms",
})
export function SearchPage() {
  const user = useCurrentUser()
  return user.data ? (
    <SearchWorkspace key={user.data.id} owner={user.data.id} />
  ) : (
    <p role="status">Checking your session…</p>
  )
}
export function SearchWorkspace({ owner }: { owner: string }) {
  const api = useAuthApi(),
    cache = useQueryClient()
  // Only form state is retained in the existing, non-persisted owner-scoped cache.
  // Results, cursors and suggestions are always fresh and never survive navigation.
  const [draft, setDraft] = useState<Draft>(
    () => cache.getQueryData<Draft>(["search-draft", owner]) ?? empty()
  )
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string>()
  const [selected, setSelected] = useState<SelectedSource | null>(null)
  const [dismissKey, setDismissKey] = useState(0)
  const active = useRef<AbortController | null>(null),
    sequence = useRef(0),
    busy = useRef(false)
  const summary = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    cache.setQueryData(["search-draft", owner], draft)
  }, [cache, owner, draft])
  useEffect(
    () => () => {
      sequence.current++
      active.current?.abort()
    },
    []
  )
  function invalidate() {
    sequence.current++
    active.current?.abort()
    busy.current = false
    setPending(false)
    setResponse(null)
    setSelected(null)
    setError(undefined)
    setDismissKey((i) => i + 1)
  }
  function change(next: Partial<Draft>) {
    invalidate()
    setDraft((value) => ({ ...value, ...next }))
  }
  async function submit(cursor?: string) {
    if (busy.current) return
    const safe = searchRequestSchema.safeParse({
      query: draft.query,
      match: draft.match,
      filters: draft.filters,
      limit: 10,
      ...(cursor ? { cursor } : {}),
    })
    if (!safe.success) {
      setError(safe.error.issues[0].message)
      return
    }
    invalidate()
    busy.current = true
    setPending(true)
    const id = ++sequence.current,
      controller = new AbortController()
    active.current = controller
    try {
      const value = await searchDocuments(
        api,
        draft.mode,
        safe.data,
        controller.signal
      )
      if (sequence.current !== id) return
      // Preserve ranks/order while guarding against repeated document IDs.
      const seen = new Set<string>()
      const results = value.results.filter((r) => {
        if (seen.has(r.documentId)) return false
        seen.add(r.documentId)
        return true
      })
      setResponse({ ...value, results })
    } catch (reason) {
      if (sequence.current !== id) return
      if (reason instanceof ApiError && reason.status === 401)
        cache.setQueryData(userKey, null)
      setError(searchError(reason))
    } finally {
      if (sequence.current === id) {
        busy.current = false
        setPending(false)
        summary.current?.focus()
      }
    }
  }
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="text-sm text-muted-foreground">
          Find your documents by keyword or combine keywords with semantic
          matches.
        </p>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="space-y-4"
      >
        <div className="flex items-end gap-2">
          <SearchInput
            value={draft.query}
            filters={draft.filters}
            change={(query) => change({ query })}
            dismissKey={dismissKey}
          />
          <Button type="submit" disabled={pending}>
            Search documents
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <DocumentFilterSelect
            title="Search mode"
            value={draft.mode}
            options={[
              { value: "keyword", label: "Keyword" },
              { value: "hybrid", label: "Hybrid" },
            ]}
            onChange={(mode) => change({ mode: mode as SearchMode })}
          />
          <DocumentFilterSelect
            title="Keyword matching"
            value={draft.match}
            options={[
              { value: "terms", label: "Search terms" },
              { value: "phrase", label: "Exact phrase" },
            ]}
            onChange={(match) => change({ match: match as "terms" | "phrase" })}
          />
        </div>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <SearchFiltersDialog
          owner={owner}
          filters={draft.filters}
          apply={(filters) => change({ filters })}
        />
        <Button
          variant="ghost"
          onClick={() => {
            invalidate()
            setDraft(empty())
            cache.removeQueries({ queryKey: ["search-draft", owner] })
          }}
        >
          Clear search
        </Button>
        {pending && (
          <Button variant="outline" onClick={invalidate}>
            Cancel search
          </Button>
        )}
      </div>
      {Object.keys(draft.filters).length > 0 && (
        <p className="text-sm text-muted-foreground">
          Active filters:{" "}
          {Object.keys(draft.filters)
            .map(
              (key) =>
                ({
                  categoryId: "category",
                  tagIds: "tag",
                  mimeType: "file type",
                  filename: "filename",
                })[key] ?? key
            )
            .join(", ")}
        </p>
      )}
      <section
        aria-label="Search results"
        aria-busy={pending}
        className="space-y-4"
      >
        <h2 ref={summary} tabIndex={-1} className="sr-only">
          Search results
        </h2>
        {pending ? (
          <div role="status" aria-label="Searching">
            <p>Searching…</p>
            <Skeleton className="mt-4 h-32 w-full" />
          </div>
        ) : error ? (
          <div className="space-y-3">
            <Alert role="alert">{error}</Alert>
            <Button variant="outline" onClick={() => void submit()}>
              Restart search
            </Button>
            {draft.mode === "hybrid" && (
              <Button
                variant="outline"
                onClick={() => change({ mode: "keyword" })}
              >
                Use Keyword mode
              </Button>
            )}
          </div>
        ) : response ? (
          <>
            <p role="status" className="text-sm text-muted-foreground">
              {response.results.length} documents on this page of a bounded
              result window.
            </p>
            <p className="text-sm text-muted-foreground">
              Index coverage: {response.coverage.metadataReadyDocuments}{" "}
              metadata-ready · {response.coverage.textReadyDocuments} text-ready
              of {response.coverage.eligibleDocuments} eligible documents.
              Coverage is not a match count.
            </p>
            {response.coverage.textReadyDocuments <
              response.coverage.eligibleDocuments && (
              <p className="text-sm text-muted-foreground">
                Some documents have only metadata available or are still being
                indexed.
              </p>
            )}
            {response.results.length === 0 && (
              <p>
                No matching documents
                {Object.keys(draft.filters).length ? " for these filters" : ""}.
                Try different terms or Keyword mode.
              </p>
            )}
            {response.results.map((result) => (
              <article
                key={result.documentId}
                className="min-w-0 space-y-3 rounded-lg border bg-card p-4"
              >
                <h3 className="font-medium break-words">
                  <Link
                    href={`/documents/${result.documentId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline"
                  >
                    {result.title}
                    <span className="sr-only">
                      {" "}
                      (document details, new tab)
                    </span>
                  </Link>
                </h3>
                <p className="text-sm break-words text-muted-foreground">
                  {result.originalFilename} · Version {result.versionNumber} ·{" "}
                  {result.documentType}
                </p>
                {result.matches.map((match, i) => (
                  <div key={i} className="space-y-2">
                    <p className="line-clamp-4 text-sm wrap-anywhere whitespace-pre-wrap">
                      <SafeHighlight
                        snippet={match.snippet}
                        ranges={
                          match.kind === "chunk" ? undefined : match.ranges
                        }
                      />
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {match.kind === "chunk"
                        ? "Semantic match"
                        : match.kind === "page"
                          ? `Keyword match · Page ${match.pageNumber}`
                          : "Metadata match"}
                    </p>
                    {(match.kind === "chunk" || match.source) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) =>
                          setSelected({
                            result,
                            match,
                            trigger: e.currentTarget,
                          })
                        }
                      >
                        {match.kind === "page"
                          ? `View page ${match.pageNumber} source`
                          : "View source"}
                      </Button>
                    )}
                  </div>
                ))}
              </article>
            ))}
            {response.pagination.nextCursor && (
              <Button
                disabled={pending}
                onClick={() =>
                  void submit(response.pagination.nextCursor ?? undefined)
                }
              >
                Next page
              </Button>
            )}
            {!response.pagination.paginationAvailable && (
              <p className="text-sm text-muted-foreground">
                Pagination is unavailable. Refine your query or restart later.
              </p>
            )}
            {!response.pagination.nextCursor && (
              <p className="text-sm text-muted-foreground">
                End of available results in this window.
              </p>
            )}
            {response.pagination.truncated && (
              <p className="text-sm text-muted-foreground">
                Results are bounded. Refine your query to explore other matches.
              </p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            Enter a query and submit to search your private documents. Queries
            and suggestions are not saved in browser storage or URLs.
          </p>
        )}
      </section>
      {selected && (
        <SearchSource
          key={`${selected.result.documentId}:${selected.match.kind}:${selected.match.kind === "chunk" ? selected.match.chunkId : selected.match.source?.sourceId}`}
          selected={selected}
          owner={owner}
          close={() => setSelected(null)}
        />
      )}
    </div>
  )
}
