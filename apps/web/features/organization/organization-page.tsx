"use client"
import { Spinner } from "@/components/ui/spinner"

import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"

import { Card } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Alert } from "@/components/ui/alert"

import { useRef, useState } from "react"
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { Plus, FolderOpen, Tags } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmationDialog } from "@/components/shared/confirmation-dialog"
import { LoadingPanel } from "@/components/shared/loading-panel"
import { useAuthApi, useCurrentUser, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import { listCategories, listTags } from "@/lib/api/documents"
import {
  saveOrganization,
  deleteOrganization,
  organizationError,
  type OrganizationKind,
  type OrganizationItem,
  type OrganizationInput,
} from "@/lib/api/organization"
import { CategoryStyle } from "./category-style"
import { OrganizationEditor } from "./organization-editor"

export function OrganizationPage({ kind }: { kind: OrganizationKind }) {
  const api = useAuthApi(),
    user = useCurrentUser(),
    cache = useQueryClient(),
    owner = user.data?.id
  const noun = kind === "categories" ? "category" : "tag",
    title = kind === "categories" ? "Categories" : "Tags",
    Icon = kind === "categories" ? FolderOpen : Tags
  const [editing, setEditing] = useState<OrganizationItem | null | undefined>(),
    [notice, setNotice] = useState<string>()
  const returnFocus = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null)
  async function authenticated<T>(run: () => Promise<T>) {
    try {
      return await run()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        cache.setQueryData(userKey, null)
      throw error
    }
  }
  const query = useInfiniteQuery({
    queryKey: [kind, owner],
    enabled: !!owner,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      authenticated(() =>
        kind === "categories"
          ? listCategories(api, pageParam)
          : listTags(api, pageParam)
      ),
    getNextPageParam: (last) =>
      last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined,
    retry: false,
  })
  const saveMutation = useMutation({
    mutationFn: ({ input, id }: { input: OrganizationInput; id?: string }) =>
      authenticated(() => saveOrganization(api, kind, input, id)),
    retry: false,
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      authenticated(() => deleteOrganization(api, kind, id)),
    retry: false,
  })
  async function invalidate() {
    await Promise.all([
      cache.invalidateQueries({ queryKey: [kind, owner] }),
      cache.invalidateQueries({ queryKey: ["documents", owner] }),
      cache.invalidateQueries({ queryKey: ["document", owner] }),
    ])
  }
  async function save(input: OrganizationInput, id?: string) {
    let item: OrganizationItem
    try {
      item = await saveMutation.mutateAsync({ input, id })
    } catch (error) {
      throw new Error(organizationError(error, kind))
    }
    setNotice(`${id ? "Updated" : "Created"} ${noun} “${item.name}”.`)
    setEditing(undefined)
    await invalidate()
  }
  async function remove(item: OrganizationItem) {
    try {
      await deleteMutation.mutateAsync(item.id)
    } catch (error) {
      throw new Error(organizationError(error, kind, true))
    }
    setNotice(
      `Deleted ${noun} “${item.name}”. Your documents were not deleted.`
    )
    await invalidate()
    requestAnimationFrame(() => heading.current?.focus())
  }
  const rows: OrganizationItem[] =
    query.data?.pages.flatMap((page) => page.data) ?? []
  const busy = saveMutation.isPending || deleteMutation.isPending
  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-3xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-ring"
          >
            {title}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {kind === "categories"
              ? "Organize your documents into clear, personal categories."
              : "Create flexible labels to find your documents more easily."}
          </p>
        </div>
        <Button
          disabled={!owner || busy}
          onClick={(event) => {
            returnFocus.current = event.currentTarget
            setEditing(null)
          }}
        >
          <Plus aria-hidden />
          Create {noun}
        </Button>
      </header>
      {notice && (
        <Alert
          role="status"
          className="rounded-lg border border-primary/30 bg-card p-4 break-words"
        >
          {notice}
        </Alert>
      )}
      <section
        aria-label={`${title} list`}
        aria-busy={query.isFetching}
        className="space-y-4"
      >
        {query.isPending ? (
          <LoadingPanel label={`Loading ${kind}…`} />
        ) : query.isError ? (
          <Alert
            variant="destructive"
            role="alert"
            className="space-y-3 rounded-xl border bg-card p-6"
          >
            <h2 className="font-semibold">Unable to load {kind}</h2>
            <p>{organizationError(query.error, kind)}</p>
            <Button
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Try again
            </Button>
          </Alert>
        ) : (
          <>
            {query.isFetching && (
              <p role="status" className="text-sm text-muted-foreground">
                <Spinner aria-hidden className="mr-2 inline size-4" />
                Refreshing {kind}…
              </p>
            )}
            {rows.length === 0 ? (
              <Card className="space-y-3 p-8 text-center">
                <Empty>
                  <Icon
                    className="mx-auto size-8 text-muted-foreground"
                    aria-hidden
                  />
                  <EmptyHeader>
                    <EmptyTitle>
                      <h2 className="text-xl font-semibold">No {kind} yet</h2>
                    </EmptyTitle>
                  </EmptyHeader>
                  <EmptyDescription className="text-sm text-muted-foreground">
                    Create your first {noun} to keep things organized.
                  </EmptyDescription>
                </Empty>
              </Card>
            ) : (
              <div className="min-w-0 rounded-xl border bg-card">
                <Table className="min-w-160">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      {kind === "categories" && (
                        <TableHead>Appearance</TableHead>
                      )}
                      <TableHead>Updated</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="max-w-64 min-w-40 whitespace-normal">
                          <h2 className="font-medium break-words">
                            {item.name}
                          </h2>
                        </TableCell>
                        {kind === "categories" && (
                          <TableCell className="min-w-32 whitespace-normal">
                            <CategoryStyle
                              color={item.color}
                              icon={item.icon}
                            />
                          </TableCell>
                        )}
                        <TableCell className="text-muted-foreground">
                          {new Intl.DateTimeFormat(undefined, {
                            dateStyle: "medium",
                          }).format(new Date(item.updatedAt))}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              disabled={busy}
                              aria-label={`${kind === "categories" ? "Edit" : "Rename"} ${item.name}`}
                              onClick={(event) => {
                                returnFocus.current = event.currentTarget
                                setEditing(item)
                              }}
                            >
                              {kind === "categories" ? "Edit" : "Rename"}
                            </Button>
                            <ConfirmationDialog
                              action="Delete"
                              title={`Delete ${noun}?`}
                              description={
                                kind === "categories"
                                  ? `Permanently delete “${item.name}”? Deletion is blocked if any document, including a soft-deleted document, still uses this category. Documents are not deleted or automatically uncategorized.`
                                  : `Permanently delete “${item.name}”? This removes the tag from all assigned documents. The documents themselves are kept.`
                              }
                              destructive
                              disabled={busy}
                              confirm={() => remove(item)}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {query.hasNextPage && (
              <Button
                variant="outline"
                disabled={query.isFetching || busy}
                onClick={() => void query.fetchNextPage()}
              >
                Load more {kind}
              </Button>
            )}
          </>
        )}
      </section>
      {editing !== undefined && (
        <OrganizationEditor
          key={editing?.id ?? "new"}
          kind={kind}
          item={editing}
          close={() => setEditing(undefined)}
          save={save}
          returnFocus={returnFocus}
        />
      )}
    </div>
  )
}
