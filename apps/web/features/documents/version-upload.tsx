"use client"
import { Spinner } from "@/components/ui/spinner"

import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { FieldLabel, FieldError } from "@/components/ui/field"
import { Card } from "@/components/ui/card"

import { useEffect, useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { ConfirmationDialog } from "@/components/shared/confirmation-dialog"
import { useAuthApi } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import {
  uploadVersion,
  versionError,
  type VersionReceipt,
} from "@/lib/api/versions"
import { fileError, formatBytes } from "./upload-validation"

export function VersionUpload({
  documentId,
  maxBytes,
  close,
  saved,
  expired,
}: {
  documentId: string
  maxBytes: number
  close: () => void
  saved: (receipt: VersionReceipt) => Promise<void>
  expired: () => void
}) {
  const api = useAuthApi()
  const [file, setFile] = useState<File>(),
    [issue, setIssue] = useState<string>(),
    [progress, setProgress] = useState<number | null>(null)
  const attempt = useRef<string | null>(null),
    controller = useRef<AbortController | null>(null),
    busy = useRef(false),
    picker = useRef<HTMLInputElement>(null)
  const mutation = useMutation({
    mutationFn: ({
      selected,
      key,
      signal,
    }: {
      selected: File
      key: string
      signal: AbortSignal
    }) =>
      uploadVersion(api, documentId, selected, key, {
        signal,
        onProgress: setProgress,
      }),
    retry: false,
  })
  useEffect(() => {
    picker.current?.focus()
    return () => controller.current?.abort()
  }, [])
  useEffect(() => {
    if (!mutation.isPending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [mutation.isPending])
  function select(files: FileList | File[]) {
    if (busy.current) return
    const selected = files.length === 1 ? files[0] : undefined
    setFile(selected)
    setProgress(null)
    attempt.current = null
    setIssue(
      files.length > 1
        ? "Choose exactly one file."
        : fileError(selected, maxBytes)
    )
  }
  async function submit() {
    if (busy.current || !file || fileError(file, maxBytes)) return
    busy.current = true
    setProgress(null)
    attempt.current ??= crypto.randomUUID()
    controller.current = new AbortController()
    let receipt: VersionReceipt
    try {
      receipt = await mutation.mutateAsync({
        selected: file,
        key: attempt.current,
        signal: controller.current.signal,
      })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expired()
      throw new Error(versionError(error, true))
    } finally {
      busy.current = false
      controller.current = null
    }
    // The upload is committed. Refresh failures must not invite another upload.
    await saved(receipt)
  }
  return (
    <Card
      aria-labelledby="version-upload-title"
      className="space-y-4 p-5 sm:p-6"
    >
      <h2 id="version-upload-title" className="text-xl font-semibold">
        Upload a new immutable version
      </h2>
      <p className="text-sm text-muted-foreground">
        This updates the current file for this document. Older versions remain
        available and are never overwritten. The title, category, tags and other
        document metadata stay unchanged.
      </p>
      <FieldLabel htmlFor="version-file" className="block text-sm font-medium">
        New version file *
      </FieldLabel>
      <p id="version-file-hint" className="text-sm text-muted-foreground">
        One PDF, JPEG or PNG, up to {formatBytes(maxBytes)}. The server verifies
        file contents, PDF encryption and page limits.
      </p>
      <Input
        ref={picker}
        id="version-file"
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        disabled={mutation.isPending}
        aria-invalid={!!issue}
        aria-describedby={`version-file-hint${issue ? " version-file-error" : ""}`}
        className="h-auto min-h-11 py-2"
        onChange={(event) => {
          if (event.target.files?.length) select(event.target.files)
          event.target.value = ""
        }}
      />
      {file && (
        <div className="space-y-2 rounded-lg bg-muted/40 p-4 text-sm">
          <p className="break-all">{file.name}</p>
          <p>
            {file.type || "Unknown type"} · {formatBytes(file.size)}
          </p>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => select([])}
          >
            Remove file
          </Button>
        </div>
      )}
      {issue && (
        <FieldError
          role="alert"
          id="version-file-error"
          className="text-sm text-destructive"
        >
          {issue}
        </FieldError>
      )}
      <div className="flex flex-wrap gap-3">
        <ConfirmationDialog
          action="Upload new version"
          title="Make this the current version?"
          description={`Upload ${file?.name ?? "the selected file"} as a new immutable version? Older versions remain in history. The server assigns the next version number.`}
          disabled={!file || !!issue || mutation.isPending}
          confirm={submit}
          pendingContent={
            <div className="space-y-3">
              <p role="status">
                <Spinner aria-hidden className="mr-2 inline size-4" />
                {progress === 100
                  ? "File sent. Waiting for server confirmation…"
                  : progress === null
                    ? "Uploading…"
                    : `Uploading… ${progress}%`}
              </p>
              <Progress
                aria-label="Version upload progress"
                className="w-full accent-primary"
                max={100}
                value={progress}
              />
              <Button
                variant="outline"
                onClick={() => controller.current?.abort()}
              >
                Cancel upload
              </Button>
              <p className="text-xs text-muted-foreground">
                Cancellation stops this request, but the server may already have
                saved the version. Check history before trying again.
              </p>
            </div>
          }
        />
        <Button variant="outline" disabled={mutation.isPending} onClick={close}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        An unchanged retry in this open form reuses the upload key. After
        closing this form or reloading, check history before starting a new
        attempt.
      </p>
    </Card>
  )
}
