"use client"
import { useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import { ConfirmationDialog } from "@/components/shared/confirmation-dialog"
import { useAuthApi, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import { aiError, reprocessDocument } from "@/lib/api/ai"
import { getProcessingStatus, processingStatusKey } from "@/lib/api/processing"
import {
  shouldPollProcessing,
  processingPollIntervalMs,
} from "./processing-presentation"

export function AiDocumentStatus({
  owner,
  documentId,
  versionId,
  archived,
}: {
  owner: string
  documentId: string
  versionId: string
  archived: boolean
}) {
  const api = useAuthApi(),
    cache = useQueryClient(),
    key = processingStatusKey(owner, documentId, versionId)
  const [receipt, setReceipt] = useState<string>(),
    [notice, setNotice] = useState<string>()
  const idempotency = useRef<string | null>(null)
  const previousArchive = useRef(archived)
  useEffect(() => {
    if (previousArchive.current !== archived) {
      previousArchive.current = archived
      void cache.invalidateQueries({
        queryKey: processingStatusKey(owner, documentId, versionId),
      })
    }
  }, [archived, cache, owner, documentId, versionId])
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      try {
        return await getProcessingStatus(api, documentId, versionId)
      } catch (error) {
        if (error instanceof ApiError && error.status === 401)
          cache.setQueryData(userKey, null)
        throw error
      }
    },
    retry: false,
    refetchInterval: (state) =>
      shouldPollProcessing(state.state.data) ||
      (receipt && state.state.data?.pipeline?.runId !== receipt)
        ? processingPollIntervalMs
        : false,
  })
  const labels = {
    READY: "Ready for AI search",
    PROCESSING: "Preparing document",
    FAILED: "AI preparation failed",
    UNAVAILABLE: "Not available for AI search",
    UNSUPPORTED: "File type not supported for AI search",
  }
  const status = query.data?.aiReadiness ?? "UNAVAILABLE"
  const scheduled = !!receipt && query.data?.pipeline?.runId !== receipt
  async function reprocess() {
    idempotency.current ??= crypto.randomUUID()
    try {
      const result = await reprocessDocument(
        api,
        documentId,
        versionId,
        idempotency.current
      )
      setReceipt(result.runId)
      setNotice(
        "Document preparation scheduled. Your original file is unchanged."
      )
      idempotency.current = null
      await cache.invalidateQueries({ queryKey: key })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        cache.setQueryData(userKey, null)
      throw new Error(aiError(error))
    }
  }
  return (
    <section aria-label="AI preparation" className="space-y-3">
      <h3 className="text-sm font-medium">AI preparation</h3>
      {query.isPending ? (
        <p role="status">Checking preparation…</p>
      ) : query.isError ? (
        <Alert role="alert">Could not check AI preparation.</Alert>
      ) : (
        <Badge variant="secondary" className="h-auto whitespace-normal">
          {archived
            ? labels.UNAVAILABLE
            : scheduled
              ? labels.PROCESSING
              : labels[status]}
        </Badge>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <ConfirmationDialog
        action="Reprocess for AI"
        title="Prepare search data again?"
        description="Qyvra will prepare AI search data for this document. This may use paid providers and take time. Your original file is preserved."
        disabled={
          archived ||
          query.isPending ||
          query.isError ||
          status === "UNSUPPORTED" ||
          query.data?.pipeline?.status === "BUILDING" ||
          scheduled
        }
        confirm={reprocess}
      />
    </section>
  )
}
