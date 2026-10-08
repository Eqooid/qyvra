"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { useAuthApi, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import {
  getProcessingStatus,
  processingStatusKey,
  type ProcessingStatus,
} from "@/lib/api/processing"
import {
  processingFailureLabel,
  processingLabel,
  processingPollIntervalMs,
  processingStageLabel,
  shouldPollProcessing,
} from "./processing-presentation"

function processingTime(value: string) {
  return (
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  )
}

/** Pure presentation of the owned API response; no broker/cache vocabulary. */
export function ProcessingStatusContent({
  status,
}: {
  status: ProcessingStatus
}) {
  if (status.jobs.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No processing information for this version.
      </p>
    )

  return (
    <ul className="space-y-3">
      {status.jobs.map((job) => {
        const activeProgress =
          job.status === "PROCESSING" && job.progress?.attempt === job.attempts
            ? job.progress
            : null
        const failure = processingFailureLabel(job.failureCode, job.jobType)
        const label = processingLabel(job)
        return (
          <li
            key={job.id}
            className="min-w-0 space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={job.status === "FAILED" ? "destructive" : "secondary"}
                className="h-auto max-w-full whitespace-normal"
              >
                {label}
              </Badge>
              {job.status === "PROCESSING" && activeProgress && (
                <span className="text-sm tabular-nums">
                  {activeProgress.percent}%
                </span>
              )}
            </div>
            {activeProgress && (
              <div className="space-y-1">
                <Progress
                  aria-label={`${label} progress`}
                  value={activeProgress.percent}
                  max={100}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  {processingStageLabel(activeProgress.stage)}
                </p>
              </div>
            )}
            {job.status === "PROCESSING" && !activeProgress && (
              <p className="text-sm text-muted-foreground">
                {job.jobType === "VERIFY_STORED_FILE"
                  ? "Verification is in progress."
                  : "Document preparation is in progress."}
              </p>
            )}
            {job.status === "RETRYING" && (
              <p className="text-sm text-muted-foreground">
                {job.nextRetryAt
                  ? `Another attempt is scheduled for ${processingTime(job.nextRetryAt)}.`
                  : "Another attempt is scheduled."}
              </p>
            )}
            {job.status === "PROCESSING" && job.attempts > 1 && (
              <p className="text-xs text-muted-foreground">
                Attempt {job.attempts} of {job.maxAttempts}
              </p>
            )}
            {(job.status === "FAILED" || job.status === "RETRYING") &&
              failure && (
                <p className="text-sm break-words text-muted-foreground">
                  {failure}
                </p>
              )}
          </li>
        )
      })}
    </ul>
  )
}

/** One query per visible version; TanStack Query owns the polling timer. */
export function ProcessingStatusSection({
  owner,
  documentId,
  versionId,
}: {
  owner: string
  documentId: string
  versionId: string
}) {
  const api = useAuthApi()
  const cache = useQueryClient()
  const query = useQuery({
    queryKey: processingStatusKey(owner, documentId, versionId),
    queryFn: async () => {
      try {
        return await getProcessingStatus(api, documentId, versionId)
      } catch (error) {
        if (error instanceof ApiError && error.status === 401)
          cache.setQueryData(userKey, null)
        throw error
      }
    },
    refetchInterval: (current) =>
      shouldPollProcessing(current.state.data)
        ? processingPollIntervalMs
        : false,
    retry: false,
  })

  return (
    <section aria-label="File processing" className="min-w-0 space-y-2">
      <h3 className="text-sm font-medium">
        {query.data?.pipeline ? "Document processing" : "File integrity"}
      </h3>
      {query.isPending ? (
        <div
          role="status"
          aria-label="Loading processing status"
          className="space-y-2"
        >
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-3 w-full max-w-xs" />
        </div>
      ) : (
        <>
          {query.isError && (
            <Alert
              role="alert"
              className="flex flex-wrap items-center gap-2 p-3"
            >
              <span>Could not refresh processing status.</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void query.refetch()}
              >
                Retry status
              </Button>
            </Alert>
          )}
          {query.data && <ProcessingStatusContent status={query.data} />}
        </>
      )}
    </section>
  )
}
