"use client"
import { Spinner } from "@/components/ui/spinner"

import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"

import { Card } from "@/components/ui/card"
import { NativeSelectOption } from "@/components/ui/native-select"
import { Alert } from "@/components/ui/alert"

import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination"
import Link from "next/link"
import { Files, CircleAlert, Upload } from "lucide-react"
import { LoadingPanel } from "@/components/shared/loading-panel"
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
  listDocuments,
  listCategories,
  listTags,
  queryString,
  statuses,
} from "@/lib/api/documents"
import { hasFilters, readDocumentQuery } from "./query"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const label = (value: string) => value.toLowerCase().replaceAll("_", " ")

function FilterSelect({
  title,
  value,
  options,
  disabled,
  onChange,
}: {
  title: string
  value: string
  options: { value: string; label: string }[]
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <Field className="min-w-0">
      <FieldLabel htmlFor={id}>{title}</FieldLabel>
      <Select
        items={options}
        value={value}
        disabled={disabled}
        onValueChange={(next) => onChange(next ?? "")}
      >
        <SelectTrigger id={id} className="w-full min-w-0">
          <SelectValue className="truncate" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            <SelectLabel>{title}</SelectLabel>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="truncate">{option.label}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

function Search({
  value,
  commit,
}: {
  value: string
  commit: (value: string) => void
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
    <Field className="w-full min-w-0 sm:max-w-sm">
      <FieldLabel htmlFor={id} className="sr-only">
        Search documents
      </FieldLabel>
      <Input
        id={id}
        type="search"
        placeholder="Search documents..."
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
  function navigate(next: DocumentQuery) {
    const normalized = readDocumentQuery(new URLSearchParams(queryString(next)))
    router.push(`/documents?${queryString(normalized)}`, { scroll: false })
  }
  function change(key: keyof DocumentQuery, value: string) {
    navigate({ ...query, cursor: undefined, [key]: value || undefined })
  }
  const clear = () => router.push("/documents", { scroll: false })
  const categoryItems =
    categories.data?.pages.flatMap((page) => page.data) ?? []
  const tagItems = tags.data?.pages.flatMap((page) => page.data) ?? []
  const types = [
    "INVOICE",
    "RECEIPT",
    "STATEMENT",
    "CONTRACT",
    "CERTIFICATE",
    "WARRANTY",
    "INSURANCE",
    "IDENTITY",
    "OTHER",
  ]
  if (query.documentType && !types.includes(query.documentType))
    types.push(query.documentType)
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
        <Link
          href="/documents/upload"
          className={buttonVariants({ size: "lg" })}
        >
          <Upload aria-hidden />
          Upload document
        </Link>
      </div>
      <Accordion defaultValue={["filters"]}>
        <AccordionItem value="filters" className="rounded-sm border p-3">
          <AccordionTrigger>Filters and sorting</AccordionTrigger>
          <AccordionContent>
            <FieldGroup className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field className="min-w-0">
                <FieldLabel htmlFor="document-type-filter">
                  Document type
                </FieldLabel>
                <Input
                  id="document-type-filter"
                  list="document-types"
                  placeholder="All types"
                  value={query.documentType ?? ""}
                  onChange={(event) =>
                    change("documentType", event.target.value.toUpperCase())
                  }
                />
                <datalist id="document-types">
                  {types.map((type) => (
                    <NativeSelectOption key={type} value={type} />
                  ))}
                </datalist>
              </Field>
              <FilterSelect
                title="Status"
                value={query.status ?? ""}
                options={[
                  { value: "", label: "All statuses" },
                  ...statuses.map((status) => ({
                    value: status,
                    label: label(status),
                  })),
                ]}
                onChange={(value) => change("status", value)}
              />
              <div className="min-w-0">
                <FilterSelect
                  title="Category"
                  value={query.categoryId ?? ""}
                  disabled={categories.isPending || categories.isError}
                  options={[
                    {
                      value: "",
                      label: categories.isPending
                        ? "Loading categories..."
                        : "All categories",
                    },
                    ...(query.categoryId &&
                    !categoryItems.some((item) => item.id === query.categoryId)
                      ? [
                          {
                            value: query.categoryId,
                            label: "Selected category (not loaded)",
                          },
                        ]
                      : []),
                    ...categoryItems.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                  onChange={(value) => change("categoryId", value)}
                />
                {categories.isError && (
                  <Alert
                    variant="destructive"
                    role="alert"
                    className="text-sm text-muted-foreground"
                  >
                    Categories unavailable.{" "}
                    <Button
                      variant="link"
                      onClick={() => void categories.refetch()}
                    >
                      Retry categories
                    </Button>
                  </Alert>
                )}
                {categories.hasNextPage && (
                  <Button
                    variant="link"
                    disabled={categories.isFetching}
                    onClick={() => void categories.fetchNextPage()}
                  >
                    Load more categories
                  </Button>
                )}
              </div>
              <div className="min-w-0">
                <FilterSelect
                  title="Tag"
                  value={query.tagId ?? ""}
                  disabled={tags.isPending || tags.isError}
                  options={[
                    {
                      value: "",
                      label: tags.isPending ? "Loading tags..." : "All tags",
                    },
                    ...(query.tagId &&
                    !tagItems.some((item) => item.id === query.tagId)
                      ? [
                          {
                            value: query.tagId,
                            label: "Selected tag (not loaded)",
                          },
                        ]
                      : []),
                    ...tagItems.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                  onChange={(value) => change("tagId", value)}
                />
                {tags.isError && (
                  <Alert
                    variant="destructive"
                    role="alert"
                    className="text-sm text-muted-foreground"
                  >
                    Tags unavailable.{" "}
                    <Button variant="link" onClick={() => void tags.refetch()}>
                      Retry tags
                    </Button>
                  </Alert>
                )}
                {tags.hasNextPage && (
                  <Button
                    variant="link"
                    disabled={tags.isFetching}
                    onClick={() => void tags.fetchNextPage()}
                  >
                    Load more tags
                  </Button>
                )}
              </div>
              <FilterSelect
                title="Archive state"
                value={query.archived ?? ""}
                options={[
                  { value: "", label: "Active and archived" },
                  { value: "false", label: "Not archived" },
                  { value: "true", label: "Archived" },
                ]}
                onChange={(value) => change("archived", value)}
              />
              <FilterSelect
                title="Sort"
                value={query.sort ?? "-createdAt"}
                options={[
                  { value: "-createdAt", label: "Newest first" },
                  { value: "createdAt", label: "Oldest first" },
                ]}
                onChange={(value) => change("sort", value)}
              />
            </FieldGroup>
            <Button className="mt-4" variant="outline" onClick={clear}>
              Clear filters
            </Button>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <section
        aria-label="Document results"
        aria-busy={documents.isFetching}
        className="space-y-4"
      >
        <DocumentsTable
          data={documents.data?.data}
          uploadedId={notice.data?.id}
          toolbar={
            <Search
              value={query.q ?? ""}
              commit={(value) => change("q", value)}
            />
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
                onClick={() => navigate({ ...query, cursor: undefined })}
              >
                First page
              </Button>
            </PaginationItem>
          )}
          <PaginationItem>
            <Button
              variant="outline"
              disabled={
                documents.isFetching ||
                documents.isError ||
                !documents.data?.meta.hasMore ||
                !documents.data.meta.nextCursor
              }
              onClick={() =>
                navigate({
                  ...query,
                  cursor: documents.data?.meta.nextCursor ?? undefined,
                })
              }
            >
              Next page
            </Button>
          </PaginationItem>
          <PaginationItem>
            <span className="text-sm text-muted-foreground">
              Up to {query.limit} documents per page
            </span>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
