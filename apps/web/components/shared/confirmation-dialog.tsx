"use client"
import { Spinner } from "@/components/ui/spinner"

import { Alert } from "@/components/ui/alert"

import { useRef, useState } from "react"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

/** Async confirmation with retryable errors and guarded dismissal. */
export function ConfirmationDialog({
  action,
  title,
  description,
  disabled,
  destructive = false,
  confirm,
  pendingContent,
}: {
  action: string
  title: string
  description: string
  disabled?: boolean
  destructive?: boolean
  confirm: () => Promise<void>
  pendingContent?: React.ReactNode
}) {
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>()
  const cancel = useRef<HTMLButtonElement>(null),
    busy = useRef(false)
  async function run() {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(undefined)
    try {
      await confirm()
      setOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Please try again.")
    } finally {
      setPending(false)
      busy.current = false
    }
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) {
          setOpen(value)
          setError(undefined)
        }
      }}
    >
      <AlertDialogTrigger
        render={
          <Button
            variant={destructive ? "destructive" : "outline"}
            disabled={disabled}
          />
        }
      >
        {action}
      </AlertDialogTrigger>

      <AlertDialogContent
        initialFocus={cancel}
        className="max-h-[90svh] max-w-[calc(100%-2rem)] overflow-y-auto break-words sm:max-w-md"
      >
        <AlertDialogTitle className="font-heading text-xl break-words">
          {title}
        </AlertDialogTitle>
        <AlertDialogDescription className="text-sm break-words text-muted-foreground">
          {description}
        </AlertDialogDescription>
        {error && (
          <Alert
            variant="destructive"
            role="alert"
            className="text-sm text-destructive"
          >
            {error}
          </Alert>
        )}
        {pending && (
          <p role="status">
            <Spinner aria-hidden className="mr-2 inline size-4" />
            Saving change…
          </p>
        )}
        {pending && pendingContent}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancel} disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            variant={destructive ? "destructive" : "default"}
            onClick={() => void run()}
          >
            {pending ? "Please wait…" : `Confirm ${action.toLowerCase()}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
