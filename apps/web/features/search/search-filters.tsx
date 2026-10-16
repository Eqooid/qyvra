"use client"
import { useState } from "react"
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DocumentFilterSelect } from "@/features/documents/document-filter-select"
import { useAuthApi, userKey } from "@/features/auth/provider"
import { listCategories, listTags } from "@/lib/api/documents"
import { ApiError } from "@/lib/api/client"
import { searchFiltersSchema, type SearchFilters } from "@/lib/api/search"

export function SearchFiltersDialog({
  owner,
  filters,
  apply,
}: {
  owner: string
  filters: SearchFilters
  apply: (filters: SearchFilters) => void
}) {
  const api = useAuthApi(),
    cache = useQueryClient()
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(filters)
  const lookups = ["categories", "tags"] as const
  function useLookup(kind: (typeof lookups)[number]) {
    return useInfiniteQuery({
      queryKey: ["search-lookups", owner, kind],
      enabled: open,
      initialPageParam: undefined as string | undefined,
      queryFn: async ({ pageParam }) => {
        try {
          return await (kind === "categories"
            ? listCategories(api, pageParam)
            : listTags(api, pageParam))
        } catch (error) {
          if (error instanceof ApiError && error.status === 401)
            cache.setQueryData(userKey, null)
          throw error
        }
      },
      getNextPageParam: (page) =>
        page.meta.hasMore ? (page.meta.nextCursor ?? undefined) : undefined,
    })
  }
  const categories = useLookup("categories"),
    tags = useLookup("tags")
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(filters)
        setOpen(next)
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        Filters
        {Object.keys(filters).length ? ` (${Object.keys(filters).length})` : ""}
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Search filters</DialogTitle>
          <DialogDescription>
            Applies to this search and private suggestions. Archived documents
            are excluded.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {lookups.map((kind, i) => {
            const lookup = i === 0 ? categories : tags
            const field = kind === "categories" ? "categoryId" : "tagIds"
            return (
              <div key={kind} className="space-y-2">
                <DocumentFilterSelect
                  title={kind === "categories" ? "Category" : "Tag"}
                  value={
                    kind === "categories"
                      ? (draft.categoryId ?? "")
                      : (draft.tagIds?.[0] ?? "")
                  }
                  options={[
                    { value: "", label: "Any" },
                    ...(lookup.data?.pages
                      .flatMap((p) => p.data)
                      .map((item) => ({ value: item.id, label: item.name })) ??
                      []),
                  ]}
                  onChange={(value) => {
                    const next = { ...draft }
                    delete next[field]
                    if (value) {
                      if (field === "categoryId") next.categoryId = value
                      else next.tagIds = [value]
                    }
                    setDraft(next)
                  }}
                  disabled={lookup.isPending}
                />
                {lookup.isError && (
                  <Button
                    variant="outline"
                    onClick={() => void lookup.refetch()}
                  >
                    Retry {kind}
                  </Button>
                )}
                {lookup.hasNextPage && (
                  <Button
                    variant="outline"
                    disabled={lookup.isFetching}
                    onClick={() => void lookup.fetchNextPage()}
                  >
                    More {kind}
                  </Button>
                )}
              </div>
            )
          })}
          <DocumentFilterSelect
            title="File type"
            value={draft.mimeType ?? ""}
            options={[
              { value: "", label: "Any file type" },
              { value: "application/pdf", label: "PDF" },
              { value: "image/png", label: "PNG" },
              { value: "image/jpeg", label: "JPEG" },
            ]}
            onChange={(value) => {
              const next = { ...draft }
              delete next.mimeType
              if (value)
                next.mimeType = searchFiltersSchema.shape.mimeType.parse(value)
              setDraft(next)
            }}
          />
          <div className="space-y-2">
            <Label htmlFor="search-filename">Filename contains</Label>
            <Input
              id="search-filename"
              maxLength={200}
              value={draft.filename ?? ""}
              onChange={(e) => {
                const next = { ...draft }
                delete next.filename
                if (e.target.value.trim()) next.filename = e.target.value
                setDraft(next)
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              apply({})
              setOpen(false)
            }}
          >
            Reset filters
          </Button>
          <Button
            onClick={() => {
              apply(searchFiltersSchema.parse(draft))
              setOpen(false)
            }}
          >
            Apply filters
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
