"use client"
import { Spinner } from "@/components/ui/spinner"

import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import { Card } from "@/components/ui/card"

import Link from "next/link"
import { LoadingPanel } from "@/components/shared/loading-panel"
import { StatusBadge } from "@/components/shared/status-badge"
import { useRouter } from "next/navigation"
import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { Button, buttonVariants } from "@/components/ui/button"
import { ConfirmationDialog } from "@/components/shared/confirmation-dialog"
import { useAuthApi, useCurrentUser, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import {
  DocumentDetail,
  getDocument,
  changeDocumentState,
  prepareDocumentDownload,
  documentActionError,
} from "@/lib/api/documents"
import { DocumentEdit } from "./document-edit"
import { formatBytes, mimeLabel } from "./upload-validation"
import { versionTime } from "./version-metadata"
import { ProcessingStatusSection } from "./processing-status"
import { AiDocumentStatus } from "./ai-document-status"

export function DocumentDetailPage({ documentId }: { documentId: string }) {
  const api = useAuthApi(),
    user = useCurrentUser(),
    cache = useQueryClient(),
    router = useRouter()
  const owner = user.data?.id,
    key = ["document", owner, documentId]
  const [editing, setEditing] = useState<DocumentDetail | null>(null),
    [notice, setNotice] = useState<string>(),
    [downloadError, setDownloadError] = useState<string>(),
    [missingFile, setMissingFile] = useState(false),
    [downloading, setDownloading] = useState(false)
  const editTrigger = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    downloadBusy = useRef(false)
  const authenticated = async <T,>(read: () => Promise<T>) => {
    try {
      return await read()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        cache.setQueryData(userKey, null)
      throw error
    }
  }
  const valid = z.string().uuid().safeParse(documentId).success
  const detail = useQuery({
    queryKey: key,
    enabled: !!owner && valid,
    queryFn: () => authenticated(() => getDocument(api, documentId)),
    retry: false,
  })
  const mutation = useMutation({
    mutationFn: (action: "archive" | "restore" | "delete") =>
      authenticated(() => changeDocumentState(api, documentId, action)),
    retry: false,
  })
  async function sync(document: DocumentDetail) {
    await cache.cancelQueries({ queryKey: key })
    cache.setQueryData(key, document)
    await Promise.all([
      cache.invalidateQueries({ queryKey: key }),
      cache.invalidateQueries({ queryKey: ["documents", owner] }),
    ])
  }
  async function action(kind: "archive" | "restore" | "delete") {
    try {
      const document = await mutation.mutateAsync(kind)
      if (kind === "delete") {
        await cache.cancelQueries({ queryKey: key })
        cache.removeQueries({ queryKey: key })
        cache.setQueryData(
          ["document-action-notice", owner],
          "Document moved out of your catalog by soft deletion. It has not been permanently purged."
        )
        await cache.invalidateQueries({ queryKey: ["documents", owner] })
        router.push("/documents")
      } else {
        await sync(document)
        setNotice(
          kind === "archive"
            ? "Document archived. Its file is preserved."
            : "Document restored."
        )
        requestAnimationFrame(() => heading.current?.focus())
      }
    } catch (error) {
      throw new Error(documentActionError(error))
    }
  }
  async function download() {
    if (downloadBusy.current) return
    downloadBusy.current = true
    setDownloading(true)
    setDownloadError(undefined)
    try {
      const url = await authenticated(() =>
        prepareDocumentDownload(api, documentId)
      )
      window.location.assign(url)
      setNotice(
        "Download requested. Check your browser's downloads for completion."
      )
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setMissingFile(true)
        setDownloadError(
          "No unambiguous current file is available. Download is disabled until you refresh details."
        )
      } else
        setDownloadError(
          error instanceof ApiError && error.status === 503
            ? "The current file is unavailable. Please try again later."
            : documentActionError(error)
        )
    } finally {
      downloadBusy.current = false
      setDownloading(false)
    }
  }
  const back = (
    <Link
      href="/documents"
      className="inline-block rounded text-sm text-primary underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      Back to documents
    </Link>
  )
  if (
    !valid ||
    (detail.error instanceof ApiError && detail.error.status === 404)
  )
    return (
      <Card className="space-y-4 p-6 sm:p-8">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight">
          Document not found
        </h1>
        <p>This document is unavailable.</p>
      </Card>
    )
  if (detail.isPending || !owner)
    return (
      <div className="space-y-4">
        {back}
        <LoadingPanel label="Loading document…" />
      </div>
    )
  if (detail.isError)
    return (
      <Card className="space-y-4 p-6 sm:p-8">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight">
          Unable to load document
        </h1>
        <Alert variant="destructive" role="alert">
          {documentActionError(detail.error)}
        </Alert>
        <Button onClick={() => void detail.refetch()}>Try again</Button>
      </Card>
    )
  const document = detail.data,
    archived = document.isArchived || document.status === "ARCHIVED",
    deleting = document.status === "DELETING"
  const blockedLifecycle = deleting || document.status === "PROCESSING"
  const disabled = mutation.isPending || !!editing || downloading
  function closeEditor() {
    setEditing(null)
    requestAnimationFrame(() => editTrigger.current?.focus())
  }
  return (
    <div className="min-w-0 space-y-6">
      {back}
      <header className="space-y-3">
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-3xl font-semibold tracking-tight break-words focus-visible:outline-2 focus-visible:outline-ring"
        >
          {document.title}
        </h1>
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge
            variant="secondary"
            className="h-auto px-3 py-1 whitespace-normal"
          >
            {document.documentType}
          </Badge>
          <StatusBadge status={document.status}>{document.status}</StatusBadge>
          <span className="px-2 py-1">
            {archived ? "Archived" : "Not archived"}
          </span>
        </div>
      </header>
      {notice && (
        <Alert
          role="status"
          className="rounded-lg border border-primary bg-card p-4"
        >
          {notice}
        </Alert>
      )}
      {document.currentVersion && !deleting && (
        <AiDocumentStatus
          key={document.currentVersion.id}
          owner={owner}
          documentId={documentId}
          versionId={document.currentVersion.id}
          archived={archived}
        />
      )}
      <section aria-label="Document actions" className="flex flex-wrap gap-3">
        {!deleting && (
          <Link
            href={`/documents/${documentId}/versions`}
            className={buttonVariants({ variant: "outline" })}
          >
            Version history
          </Link>
        )}
        {!archived && (
          <Button
            ref={editTrigger}
            disabled={disabled || deleting}
            variant="outline"
            onClick={() => {
              setEditing(document)
              setNotice(undefined)
            }}
          >
            Edit metadata
          </Button>
        )}
        <Button
          disabled={
            disabled || deleting || missingFile || !document.currentVersion
          }
          onClick={() => void download()}
        >
          {downloading ? "Initiating download…" : "Download current file"}
        </Button>
        {!archived && (
          <ConfirmationDialog
            action="Archive"
            title="Archive document?"
            description={`Archive “${document.title}”? Archiving does not delete the file.`}
            disabled={disabled || blockedLifecycle}
            confirm={() => action("archive")}
          />
        )}
        {archived && (
          <ConfirmationDialog
            action="Restore"
            title="Restore document?"
            description="Return this archived document to the active catalog. This does not claim processing is complete."
            disabled={disabled || blockedLifecycle}
            confirm={() => action("restore")}
          />
        )}
        <Button
          variant="outline"
          disabled={disabled || detail.isFetching}
          onClick={() => {
            setMissingFile(false)
            setDownloadError(undefined)
            void detail.refetch()
          }}
        >
          Refresh details
        </Button>
      </section>
      {blockedLifecycle && (
        <p className="text-sm text-muted-foreground">
          Lifecycle changes are unavailable while the document is{" "}
          {document.status.toLowerCase()}.
        </p>
      )}
      {downloading && (
        <p role="status">
          <Spinner aria-hidden className="mr-2 inline size-4" />
          Checking the authorized file before starting the browser download…
        </p>
      )}
      {downloadError && (
        <Alert
          variant="destructive"
          role="alert"
          className="text-sm text-destructive"
        >
          {downloadError}
        </Alert>
      )}
      {editing ? (
        <DocumentEdit
          document={editing}
          owner={owner}
          close={closeEditor}
          saved={async (updated) => {
            await sync(updated)
            setNotice("Metadata updated.")
            closeEditor()
          }}
        />
      ) : (
        <Card className="space-y-4 p-6">
          <h2 className="text-xl font-semibold tracking-tight">Metadata</h2>
          <div className="space-y-1 border-b border-border/60 pb-4">
            <h3 className="text-sm text-muted-foreground">Description</h3>
            <p className="break-words whitespace-pre-wrap">
              {document.description ?? "No description"}
            </p>
          </div>
          <dl className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2">
            {[
              ["Issuer", document.issuer],
              ["Reference number", document.referenceNumber],
              ["Document date", document.documentDate],
              ["Expiration date", document.expirationDate],
              ["Created", document.createdAt],
              ["Updated", document.updatedAt],
              ["Category", document.category?.name],
            ].map(([label, value]) => (
              <div
                key={label}
                className="min-w-0 space-y-1 border-b border-border/60 pb-4"
              >
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="break-words">{value || "Not set"}</dd>
              </div>
            ))}
          </dl>
          <h3 className="text-sm text-muted-foreground">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {document.tags.length ? (
              document.tags.map((tag) => (
                <Badge
                  variant="secondary"
                  key={tag.id}
                  className="h-auto max-w-full px-2 py-1 break-words whitespace-normal"
                >
                  {tag.name}
                </Badge>
              ))
            ) : (
              <p className="text-sm">No tags</p>
            )}
          </div>
        </Card>
      )}
      <Card aria-labelledby="current-version-heading" className="space-y-4 p-6">
        <h2
          id="current-version-heading"
          className="text-xl font-semibold tracking-tight"
        >
          Current version
        </h2>
        {document.currentVersion ? (
          <>
            <dl className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              {[
                ["Version", `v${document.currentVersion.versionNumber}`],
                ["Filename", document.currentVersion.originalFilename],
                ["File type", mimeLabel(document.currentVersion.mimeType)],
                ["File size", formatBytes(document.currentVersion.fileSize)],
                ["Uploaded", versionTime(document.currentVersion.createdAt)],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-words">{value}</dd>
                </div>
              ))}
            </dl>
            <ProcessingStatusSection
              owner={owner}
              documentId={documentId}
              versionId={document.currentVersion.id}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No current version available.
          </p>
        )}
      </Card>
      {document.verifiedSummary && (
        <Card className="space-y-2 p-5">
          <h2 className="text-xl font-semibold tracking-tight">
            Verified summary
          </h2>
          <p className="break-words whitespace-pre-wrap">
            {document.verifiedSummary}
          </p>
        </Card>
      )}
      <section className="space-y-3 rounded-xl border border-destructive/30 p-5">
        <h2 className="text-xl font-semibold tracking-tight">
          Delete document
        </h2>
        <p className="text-sm text-muted-foreground">
          Soft deletion hides the document from this catalog. It preserves the
          file and metadata; permanent purge is not available here. This
          interface does not yet have a Trash page for recovery.
        </p>
        <ConfirmationDialog
          action="Delete"
          title="Soft-delete document?"
          description={`Remove “${document.title}” from your catalog? This is recoverable soft deletion, not permanent purge. The current interface cannot restore deleted documents.`}
          destructive
          disabled={disabled || blockedLifecycle}
          confirm={() => action("delete")}
        />
      </section>
    </div>
  )
}
