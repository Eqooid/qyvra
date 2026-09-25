"use client"
import { Spinner } from "@/components/ui/spinner"

import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"

import { Card } from "@/components/ui/card"
import { Alert } from "@/components/ui/alert"

import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination"
import Link from "next/link"
import { Files, CircleAlert, Upload, X } from "lucide-react"
import { LoadingPanel } from "@/components/shared/loading-panel"
import { Badge } from "@/components/ui/badge"
import { DocumentsTable } from "./documents-table"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useId, useState } from "react"
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Button, buttonVariants } from "@/components/ui/button"
import { useAuthApi, useCurrentUser, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import {
  DocumentQuery,
  DocumentSort,
  documentSortSchema,
  listDocuments,
  listCategories,
  listTags,
  queryString,
} from "@/lib/api/documents"
import { hasFilters, readDocumentQuery } from "./query"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import { DocumentFilterDialog } from "./document-filter-dialog"
import { DocumentFilterSelect } from "./document-filter-select"

const sortFields: {
  id: string
  label: string
  asc?: DocumentSort
  desc: DocumentSort
}[] = [
  {
    id: "createdAt",
    label: "Created date",
    asc: "createdAt",
    desc: "-createdAt",
  },
  { id: "updatedAt", label: "Updated date", desc: "-updatedAt" },
  { id: "title", label: "Title", asc: "title", desc: "-title" },
  { id: "fileSize", label: "Current file size", desc: "-fileSize" },
]

function Search({
  value,
  commit,
  label = "Search documents",
  placeholder = "Search documents...",
}: {
  value: string
  commit: (value: string) => void
  label?: string
  placeholder?: string
}) {
  const id = useId()
  const [input, setInput] = useState({ external: value, draft: value })
  // Synchronize browser navigation without remounting the focused input.
  if (input.external !== value) setInput({ external: value, draft: value })
  const draft = input.external === value ? input.draft : value
  useEffect(() => {
    if (draft.trim() === value) return
    const timer = setTimeout(() => commit(draft.trim()), 350)
    return () => clearTimeout(timer)
  }, [draft, value, commit])
  return (
    <Field className="w-full min-w-0">
      <FieldLabel htmlFor={id} className="sr-only">
        {label}
      </FieldLabel>
      <Input
        id={id}
        type="search"
        placeholder={placeholder}
        maxLength={200}
        value={draft}
        onChange={(event) =>
          setInput({ external: value, draft: event.target.value })
        }
      />
    </Field>
  )
}

export function DocumentsList() {
  const api = useAuthApi()
  const user = useCurrentUser()
  const cache = useQueryClient()
  const router = useRouter()
  const search = useSearchParams()
  const query = readDocumentQuery(new URLSearchParams(search.toString()))
  const queryKey = queryString(query)
  const context = queryString({ ...query, cursor: undefined })
  const [trail, setTrail] = useState<{
    context: string
    cursors: (string | undefined)[]
  }>({ context: "", cursors: [undefined] })
  const cursors = trail.context === context ? trail.cursors : [undefined]
  const pageIndex = cursors.findIndex((cursor) => cursor === query.cursor)
  const selectedSort = documentSortSchema.parse(query.sort ?? "-createdAt")
  const sortField =
    sortFields.find(
      (field) => field.asc === selectedSort || field.desc === selectedSort
    ) ?? sortFields[0]
  const sortDirection = sortField.asc === selectedSort ? "asc" : "desc"
  const owner = user.data?.id
  const actionNotice = useQuery<string | null>({
    queryKey: ["document-action-notice", owner],
    queryFn: async () => null,
    enabled: false,
  })
  const notice = useQuery<{ id: string; status: string } | null>({
    queryKey: ["upload-success", owner],
    queryFn: async () => null,
    enabled: false,
  })
  async function authenticated<T>(read: () => Promise<T>) {
    try {
      return await read()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        cache.setQueryData(userKey, null)
      throw error
    }
  }
  const documents = useQuery({
    queryKey: ["documents", owner, queryKey],
    enabled: !!owner,
    queryFn: () => authenticated(() => listDocuments(api, query)),
    retry: false,
  })
  const categories = useInfiniteQuery({
    queryKey: ["categories", owner],
    enabled: !!owner,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      authenticated(() => listCategories(api, pageParam)),
    getNextPageParam: (last) =>
      last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined,
    retry: false,
  })
  const tags = useInfiniteQuery({
    queryKey: ["tags", owner],
    enabled: !!owner,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => authenticated(() => listTags(api, pageParam)),
    getNextPageParam: (last) =>
      last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined,
    retry: false,
  })
  function navigate(next: DocumentQuery, resetTrail = false) {
    const normalized = readDocumentQuery(new URLSearchParams(queryString(next)))
    if (resetTrail)
      setTrail({
        context: queryString({ ...normalized, cursor: undefined }),
        cursors: [undefined],
      })
    router.push(`/documents?${queryString(normalized)}`, { scroll: false })
  }
  function change(key: keyof DocumentQuery, value: string) {
    navigate({ ...query, cursor: undefined, [key]: value || undefined }, true)
  }
  function changeFields(patch: Partial<DocumentQuery>) {
    navigate({ ...query, ...patch, cursor: undefined }, true)
  }
  const clear = () => {
    navigate({ sort: query.sort, limit: query.limit }, true)
  }
  const categoryItems =
    categories.data?.pages.flatMap((page) => page.data) ?? []
  const tagItems = tags.data?.pages.flatMap((page) => page.data) ?? []
  const selectedTagIds = query.tagIds ?? (query.tagId ? [query.tagId] : [])
  function changeSortField(id: string) {
    const field = sortFields.find((item) => item.id === id)
    if (field)
      changeFields({
        sort: sortDirection === "asc" && field.asc ? field.asc : field.desc,
      })
  }
  function changeSortDirection(direction: string) {
    if (direction === "asc" && sortField.asc)
      changeFields({ sort: sortField.asc })
    if (direction === "desc") changeFields({ sort: sortField.desc })
  }
  function nextPage() {
    const next = documents.data?.meta.nextCursor
    if (!next || !documents.data?.meta.hasMore || documents.isFetching) return
    setTrail({
      context,
      cursors: [
        ...(pageIndex >= 0 ? cursors.slice(0, pageIndex + 1) : [query.cursor]),
        next,
      ],
    })
    navigate({ ...query, cursor: next })
  }
  const activeFilters: { key: string; label: string; remove: () => void }[] = []
  for (const [key, title] of [
    ["q", "Search"],
    ["filename", "Filename"],
    ["mimeType", "File type"],
    ["documentType", "Document type"],
    ["status", "Status"],
    ["archived", "Archived"],
    ["dateFrom", "Document from"],
    ["dateTo", "Document to"],
    ["expirationFrom", "Expires from"],
    ["expirationTo", "Expires to"],
  ] as const) {
    const value = query[key]
    if (value)
      activeFilters.push({
        key,
        label: `${title}: ${value}`,
        remove: () => change(key, ""),
      })
  }
  if (query.createdFrom || query.createdTo)
    activeFilters.push({
      key: "createdRange",
      label: `Created: ${query.createdFrom ?? "Any"} – ${query.createdTo ?? "Any"}`,
      remove: () =>
        changeFields({ createdFrom: undefined, createdTo: undefined }),
    })
  if (query.updatedFrom || query.updatedTo)
    activeFilters.push({
      key: "updatedRange",
      label: `Updated: ${query.updatedFrom ?? "Any"} – ${query.updatedTo ?? "Any"}`,
      remove: () =>
        changeFields({ updatedFrom: undefined, updatedTo: undefined }),
    })
  if (query.categoryId)
    activeFilters.push({
      key: "categoryId",
      label: `Category: ${categoryItems.find((item) => item.id === query.categoryId)?.name ?? "Selected category"}`,
      remove: () => change("categoryId", ""),
    })
  for (const id of selectedTagIds)
    activeFilters.push({
      key: `tag-${id}`,
      label: `Tag: ${tagItems.find((item) => item.id === id)?.name ?? "Selected tag"}`,
      remove: () =>
        changeFields({
          tagId: undefined,
          tagIds: selectedTagIds.filter((selected) => selected !== id),
        }),
    })
  if (!owner)
    return (
      <p role="status">
        <Spinner aria-hidden className="mr-2 inline size-4" />
        Checking your session…
      </p>
    )
  return (
    <div className="min-w-0 space-y-4">
      {actionNotice.data && (
        <Alert
          role="status"
          className="rounded-xl border border-primary bg-card p-4"
        >
          {actionNotice.data}
          <Button
            variant="link"
            onClick={() =>
              cache.setQueryData(["document-action-notice", owner], null)
            }
          >
            Dismiss
          </Button>
        </Alert>
      )}
      {notice.data && (
        <Alert
          role="status"
          className="rounded-xl border border-primary bg-card p-4"
        >
          Document uploaded. Status: {notice.data.status}. Processing has not
          completed.
          <Button
            variant="link"
            onClick={() => cache.setQueryData(["upload-success", owner], null)}
          >
            Dismiss
          </Button>
        </Alert>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Documents</h1>
          <p className="mt-2 text-muted-foreground">
            Find and organize your personal records.
          </p>
        </div>
      </div>
      <section
        aria-label="Document results"
        aria-busy={documents.isFetching}
        className="space-y-4"
      >
        <DocumentsTable
          data={documents.data?.data}
          uploadedId={notice.data?.id}
          action={
            <Link
              href="/documents/upload"
              className={buttonVariants({
                size: "default",
                className: "justify-center",
              })}
            >
              <Upload aria-hidden />
              Upload document
            </Link>
          }
          toolbar={
            <div className="grid w-full min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <Search
                value={query.q ?? ""}
                commit={(value) => change("q", value)}
              />
              <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center lg:justify-end">
                <DocumentFilterDialog
                  query={query}
                  categories={categoryItems}
                  tags={tagItems}
                  categoriesPending={categories.isPending}
                  tagsPending={tags.isPending}
                  categoriesError={categories.isError}
                  tagsError={tags.isError}
                  categoriesMore={Boolean(categories.hasNextPage)}
                  tagsMore={Boolean(tags.hasNextPage)}
                  categoriesFetching={categories.isFetching}
                  tagsFetching={tags.isFetching}
                  retryCategories={() => void categories.refetch()}
                  retryTags={() => void tags.refetch()}
                  loadCategories={() => void categories.fetchNextPage()}
                  loadTags={() => void tags.fetchNextPage()}
                  apply={changeFields}
                />
                <div className="min-w-0 sm:w-40">
                  <DocumentFilterSelect
                    compact
                    title="Sort by"
                    value={sortField.id}
                    options={sortFields.map((field) => ({
                      value: field.id,
                      label: field.label,
                    }))}
                    onChange={changeSortField}
                  />
                </div>
                <div className="min-w-0 sm:w-36">
                  <DocumentFilterSelect
                    compact
                    title="Sort direction"
                    value={sortDirection}
                    options={
                      sortField.asc
                        ? [
                            { value: "desc", label: "Descending" },
                            { value: "asc", label: "Ascending" },
                          ]
                        : [{ value: "desc", label: "Descending only" }]
                    }
                    onChange={changeSortDirection}
                  />
                </div>
              </div>
              {activeFilters.length > 0 && (
                <div
                  aria-label="Active filters"
                  className="flex min-w-0 flex-wrap items-center gap-2 lg:col-span-2"
                >
                  {activeFilters.map((filter) => (
                    <Badge
                      key={filter.key}
                      variant="secondary"
                      className="h-auto max-w-full py-1"
                    >
                      <span className="max-w-48 truncate">{filter.label}</span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${filter.label} filter`}
                        onClick={filter.remove}
                      >
                        <X aria-hidden />
                      </Button>
                    </Badge>
                  ))}
                  <Button variant="link" size="sm" onClick={clear}>
                    Clear all
                  </Button>
                </div>
              )}
            </div>
          }
          hideRows={documents.isError || !documents.data?.data.length}
        >
          {documents.isFetching && (
            <LoadingPanel
              label={
                hasFilters(query) || query.cursor
                  ? "Loading this view…"
                  : "Loading documents…"
              }
            />
          )}
          {documents.isError ? (
            <Alert
              variant="destructive"
              role="alert"
              className="space-y-3 rounded-xl border bg-card p-6"
            >
              <CircleAlert className="text-destructive" aria-hidden />
              <h2 className="font-medium">Unable to load documents</h2>
              <p>
                {documents.error instanceof ApiError
                  ? documents.error.message
                  : "Please try again."}
              </p>
              <Button onClick={() => void documents.refetch()}>
                Try again
              </Button>
              {query.cursor && (
                <Button
                  variant="outline"
                  onClick={() => navigate({ ...query, cursor: undefined })}
                >
                  First page
                </Button>
              )}
            </Alert>
          ) : documents.data?.data.length === 0 ? (
            <Card className="space-y-3 p-8 text-center">
              <Empty>
                <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Files aria-hidden />
                </div>
                <EmptyHeader>
                  <EmptyTitle>
                    <h2 className="text-xl font-semibold tracking-tight">
                      {hasFilters(query)
                        ? "No matching documents"
                        : query.cursor
                          ? "No more documents"
                          : "No documents yet"}
                    </h2>
                  </EmptyTitle>
                </EmptyHeader>
                <EmptyDescription className="text-muted-foreground">
                  {hasFilters(query)
                    ? "Try another search or clear your filters."
                    : query.cursor
                      ? "Return to the first page to see your records."
                      : "Upload your first document to get started."}
                </EmptyDescription>
                {hasFilters(query) ? (
                  <Button onClick={clear}>Clear all filters</Button>
                ) : query.cursor ? (
                  <Button
                    onClick={() => navigate({ ...query, cursor: undefined })}
                  >
                    First page
                  </Button>
                ) : (
                  <Link href="/documents/upload" className={buttonVariants()}>
                    Upload your first document
                  </Link>
                )}
              </Empty>
            </Card>
          ) : null}
        </DocumentsTable>
      </section>
      <Pagination aria-label="Document pagination" className="justify-start">
        <PaginationContent className="flex-wrap gap-3">
          {query.cursor && (
            <PaginationItem>
              <Button
                variant="outline"
                disabled={documents.isFetching}
                onClick={() => navigate({ ...query, cursor: undefined })}
              >
                First page
              </Button>
            </PaginationItem>
          )}
          <PaginationItem>
            <Button
              variant="outline"
              disabled={documents.isFetching || pageIndex <= 0}
              onClick={() =>
                navigate({ ...query, cursor: cursors[pageIndex - 1] })
              }
            >
              Previous page
            </Button>
          </PaginationItem>
          <PaginationItem>
            <Button
              variant="outline"
              disabled={
                documents.isFetching ||
                documents.isError ||
                !documents.data?.meta.hasMore ||
                !documents.data.meta.nextCursor
              }
              onClick={nextPage}
            >
              Next page
            </Button>
          </PaginationItem>
          <PaginationItem>
            <span className="text-sm text-muted-foreground">
              {cursors[0] === undefined && pageIndex >= 0
                ? `Page ${pageIndex + 1} · `
                : "Current page · "}
              Up to {query.limit} documents per page
            </span>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
