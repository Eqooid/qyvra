"use client"

import { Alert } from "@/components/ui/alert"

import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { LoadingPanel } from "@/components/shared/loading-panel"
import { useAuthApi } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import { getVersion, versionError } from "@/lib/api/versions"
import { formatBytes } from "./upload-validation"

export function versionTime(value: string) {
  return (
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  )
}
export function VersionMetadata({
  documentId,
  versionId,
  owner,
  expired,
}: {
  documentId: string
  versionId: string
  owner: string
  expired: () => void
}) {
  const api = useAuthApi()
  const query = useQuery({
    queryKey: ["version", owner, documentId, versionId],
    queryFn: async () => {
      try {
        return await getVersion(api, documentId, versionId)
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) expired()
        throw error
      }
    },
    retry: false,
  })
  if (query.isPending || query.isFetching)
    return <LoadingPanel label="Loading version metadata…" />
  if (query.isError)
    return (
      <Alert variant="destructive" role="alert" className="space-y-3 p-4">
        <p>{versionError(query.error)}</p>
        <Button onClick={() => void query.refetch()}>Retry metadata</Button>
      </Alert>
    )
  const version = query.data
  return (
    <dl className="grid min-w-0 gap-4 rounded-lg bg-muted/30 p-4 text-sm sm:grid-cols-2">
      {[
        ["Version", String(version.versionNumber)],
        ["Original filename", version.originalFilename],
        ["MIME type", version.mimeType],
        ["File size", formatBytes(version.fileSize)],
        ["Uploaded", versionTime(version.createdAt)],
        ...(version.pageCount ? [["Pages", String(version.pageCount)]] : []),
        [
          "Extraction status",
          version.extractionStatus === "PENDING"
            ? "Pending — extraction is not implemented yet"
            : version.extractionStatus,
        ],
      ].map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
