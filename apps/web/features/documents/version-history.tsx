"use client"
import { Spinner } from "@/components/ui/spinner"

import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableCaption,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table"
import { Card } from "@/components/ui/card"
import { Alert } from "@/components/ui/alert"

import Link from "next/link"
import { Fragment, useRef, useState } from "react"
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { LoadingPanel } from "@/components/shared/loading-panel"
import { useAuthApi, useCurrentUser, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import { getDocument } from "@/lib/api/documents"
import {
  listVersions,
  versionError,
  type VersionReceipt,
} from "@/lib/api/versions"
import { formatBytes } from "./upload-validation"
import { VersionMetadata, versionTime } from "./version-metadata"
import { VersionUpload } from "./version-upload"

export function VersionHistory({
  documentId,
  maxBytes,
}: {
  documentId: string
  maxBytes: number
}) {
  const api = useAuthApi(),
    user = useCurrentUser(),
    cache = useQueryClient()
  const owner = user.data?.id
  const valid = z.string().uuid().safeParse(documentId).success
  const [uploading, setUploading] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [notice, setNotice] = useState<string>()
  const trigger = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null)
  const expired = () => cache.setQueryData(userKey, null)
  async function authenticated<T>(operation: () => Promise<T>) {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expired()
      throw error
    }
  }
  const document = useQuery({
    queryKey: ["document", owner, documentId],
    enabled: !!owner && valid,
    queryFn: () => authenticated(() => getDocument(api, documentId)),
    retry: false,
  })
  const historyKey = ["versions", owner, documentId]
  const history = useInfiniteQuery({
    queryKey: historyKey,
    enabled:
      !!owner &&
      valid &&
      document.isSuccess &&
      document.data.status !== "DELETING",
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      authenticated(() => listVersions(api, documentId, pageParam)),
    getNextPageParam: (last) =>
      last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined,
    retry: false,
  })
  function close() {
    setUploading(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }
  async function refresh() {
    setSelected(null)
    await cache.cancelQueries({ queryKey: historyKey })
    cache.removeQueries({ queryKey: ["version", owner, documentId] })
    await cache.resetQueries({ queryKey: historyKey })
  }
  async function saved(receipt: VersionReceipt) {
    setUploading(false)
    setNotice(
      `Version ${receipt.version.versionNumber} saved. Older versions are preserved. Processing has not completed.`
    )
    // Receipts may be replays: fetch the authoritative current version, never infer it.
    await Promise.all([
      refresh(),
      cache.invalidateQueries({ queryKey: ["document", owner, documentId] }),
      cache.invalidateQueries({ queryKey: ["documents", owner] }),
    ])
    requestAnimationFrame(() => heading.current?.focus())
  }
  const back = (
    <Link
      href={valid ? `/documents/${documentId}` : "/documents"}
      className="inline-block rounded text-sm text-primary underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {valid ? "Back to document" : "Back to documents"}
    </Link>
  )
  if (
    !valid ||
    (document.error instanceof ApiError && document.error.status === 404) ||
    document.data?.status === "DELETING"
  )
    return (
      <div className="space-y-4">
        {back}
        <h1 className="text-2xl font-semibold">Document unavailable</h1>
        <p>This document is unavailable.</p>
      </div>
    )
  if (!owner || document.isPending)
    return (
      <div className="space-y-4">
        {back}
        <LoadingPanel label="Loading version history…" />
      </div>
    )
  if (document.isError)
    return (
      <div className="space-y-4">
        {back}
        <h1 className="text-2xl font-semibold">
          Unable to load version history
        </h1>
        <Alert variant="destructive" role="alert">
          {versionError(document.error)}
        </Alert>
        <Button onClick={() => void document.refetch()}>Try again</Button>
      </div>
    )
  const blocked =
    document.data.isArchived ||
    ["ARCHIVED", "PROCESSING", "DELETING"].includes(document.data.status)
  const rows = history.data?.pages.flatMap((page) => page.data) ?? []
  return (
    <div className="min-w-0 space-y-6">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-3xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-ring"
          >
            Version history
          </h1>
          <p className="mt-2 break-words text-muted-foreground">
            {document.data.title}
          </p>
        </div>
        <Button
          ref={trigger}
          disabled={
            blocked || uploading || history.isError || history.isPending
          }
          onClick={() => {
            setUploading(true)
            setNotice(undefined)
          }}
        >
          Upload new version
        </Button>
      </header>
      <p className="text-sm text-muted-foreground">
        Newest first. Each file is immutable. Downloading a selected historical
        version is not available; current-file download remains on the document
        page.
      </p>
      {blocked && (
        <Alert
          role="status"
          className="rounded-lg border bg-muted/30 p-4 text-sm"
        >
          New versions are unavailable while this document is{" "}
          {document.data.status.toLowerCase()}.
        </Alert>
      )}
      {notice && (
        <Alert
          role="status"
          className="rounded-lg border border-primary/40 bg-card p-4"
        >
          {notice}
        </Alert>
      )}
      {uploading && (
        <VersionUpload
          documentId={documentId}
          maxBytes={maxBytes}
          saved={saved}
          close={close}
          expired={expired}
        />
      )}
      <section
        aria-label="Document versions"
        aria-busy={history.isFetching}
        className="space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">All versions</h2>
          <Button
            variant="outline"
            disabled={uploading || history.isFetching}
            onClick={() => void refresh()}
          >
            Refresh history
          </Button>
        </div>
        {history.isPending ||
        (history.isFetching && !history.isFetchingNextPage) ? (
          <LoadingPanel label="Loading versions…" />
        ) : history.isError ? (
          <Alert
            variant="destructive"
            role="alert"
            className="space-y-3 rounded-xl border bg-card p-5"
          >
            <p>{versionError(history.error)}</p>
            <Button onClick={() => void refresh()}>Retry history</Button>
          </Alert>
        ) : rows.length === 0 ? (
          <Card className="space-y-2 p-6">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  <h3 className="font-medium">No versions yet</h3>
                </EmptyTitle>
              </EmptyHeader>
              <EmptyDescription className="text-sm text-muted-foreground">
                No file versions are available for this document.
              </EmptyDescription>
            </Empty>
          </Card>
        ) : (
          <Table className="block w-full table-fixed text-left text-sm md:table">
            <TableCaption className="sr-only">
              Immutable document versions, newest first
            </TableCaption>
            <TableHeader className="hidden text-muted-foreground md:table-header-group">
              <TableRow>
                <TableHead className="w-2/5 p-3">
                  Version and filename
                </TableHead>
                <TableHead className="p-3">File</TableHead>
                <TableHead className="p-3">Uploaded (UTC)</TableHead>
                <TableHead className="p-3">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="block space-y-3 md:table-row-group">
              {rows.map((version) => (
                <Fragment key={version.id}>
                  <TableRow className="block rounded-xl border bg-card p-4 md:table-row md:p-0">
                    <TableCell className="block min-w-0 space-y-2 whitespace-normal md:table-cell md:p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          Version {version.versionNumber}
                        </span>
                        {version.isLatest && (
                          <Badge
                            variant="secondary"
                            className="h-auto px-2 py-1 whitespace-normal"
                          >
                            Current / latest
                          </Badge>
                        )}
                      </div>
                      <p className="break-all">{version.originalFilename}</p>
                    </TableCell>
                    <TableCell className="block py-2 whitespace-normal md:table-cell md:p-4">
                      <p>{version.mimeType}</p>
                      <p className="text-muted-foreground">
                        {formatBytes(version.fileSize)}
                      </p>
                      {version.pageCount !== null && (
                        <p>{version.pageCount} pages</p>
                      )}
                    </TableCell>
                    <TableCell className="block pb-3 whitespace-normal md:table-cell md:p-4">
                      <time dateTime={version.createdAt}>
                        {versionTime(version.createdAt)}
                      </time>
                    </TableCell>
                    <TableCell className="block md:table-cell md:p-4">
                      <Button
                        variant="outline"
                        aria-expanded={selected === version.id}
                        aria-label={`${selected === version.id ? "Close metadata" : "Inspect"} version ${version.versionNumber}`}
                        aria-controls={`metadata-${version.id}`}
                        onClick={() =>
                          setSelected(
                            selected === version.id ? null : version.id
                          )
                        }
                      >
                        {selected === version.id ? "Close metadata" : "Inspect"}
                        <span className="sr-only">
                          {" "}
                          version {version.versionNumber}
                        </span>
                      </Button>
                    </TableCell>
                  </TableRow>
                  {selected === version.id && (
                    <TableRow className="block md:table-row">
                      <TableCell
                        colSpan={4}
                        className="block pb-4 md:table-cell"
                      >
                        <div
                          id={`metadata-${version.id}`}
                          role="region"
                          aria-label={`Version ${version.versionNumber} metadata`}
                        >
                          <VersionMetadata
                            documentId={documentId}
                            versionId={version.id}
                            owner={owner}
                            expired={expired}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
        {history.isFetchingNextPage && (
          <p role="status">
            <Spinner aria-hidden className="mr-2 inline size-4" />
            Loading older versions…
          </p>
        )}
        {history.hasNextPage && !history.isError && (
          <Button
            variant="outline"
            disabled={history.isFetching || uploading}
            onClick={() => void history.fetchNextPage()}
          >
            Load older versions
          </Button>
        )}
      </section>
    </div>
  )
}
