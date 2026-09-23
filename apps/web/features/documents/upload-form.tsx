"use client"
import { Spinner } from "@/components/ui/spinner"

import { Progress } from "@/components/ui/progress"
import { Alert } from "@/components/ui/alert"
import { FieldError } from "@/components/ui/field"

import Link from "next/link"
import { Upload } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { Controller, type Control, FieldErrors, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { Button, buttonVariants } from "@/components/ui/button"
import { useAuthApi, useCurrentUser, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import { listCategories, listTags } from "@/lib/api/documents"
import {
  UploadAttempt,
  UploadMetadata,
  uploadDocument,
  uploadError,
} from "@/lib/api/upload"
import { fileError, formatBytes, uploadFormSchema } from "./upload-validation"
import { Card, CardContent } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { UseFormRegister } from "react-hook-form"
import { DatePickerControl } from "@/components/shared/date-picker-control"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

function SelectField({
  name,
  label,
  control,
  items,
  disabled,
}: {
  name: "categoryId" | "tagIds"
  label: string
  control: Control<UploadMetadata>
  items: { label: string; value: string }[]
  disabled: boolean
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <Select
            items={items}
            multiple={name === "tagIds"}
            value={field.value}
            name={field.name}
            disabled={disabled}
            onValueChange={(value) =>
              field.onChange(value ?? (name === "tagIds" ? [] : ""))
            }
          >
            <SelectTrigger
              id={name}
              ref={field.ref}
              onBlur={field.onBlur}
              className="w-full"
              aria-invalid={fieldState.invalid}
              aria-describedby={fieldState.error ? name + "-error" : undefined}
            >
              <SelectValue
                placeholder={name === "tagIds" ? "Choose tags" : "No category"}
              />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldError id={name + "-error"} errors={[fieldState.error]} />
        </Field>
      )}
    />
  )
}

function TextField({
  name,
  label,
  max,
  type,
  errors,
  register,
}: {
  name: keyof UploadMetadata
  label: string
  max?: number | undefined
  type?: string | undefined
  errors: FieldErrors<UploadMetadata>
  register: UseFormRegister<UploadMetadata>
}) {
  return (
    <FieldGroup className="min-w-0 space-y-2">
      <Field className="min-w-0">
        <FieldLabel htmlFor={name}>{label}</FieldLabel>
        <Input
          id={name}
          type={type ?? "text"}
          maxLength={max}
          aria-invalid={!!errors[name]}
          aria-describedby={errors[name] ? `${name}-error` : undefined}
          {...register(name)}
        />
        {errors[name] && (
          <FieldError
            id={`${name}-error`}
            role="alert"
            className="text-sm text-destructive"
          >
            {errors[name]?.message}
          </FieldError>
        )}
      </Field>
    </FieldGroup>
  )
}

export function UploadForm({ maxBytes }: { maxBytes: number }) {
  const api = useAuthApi(),
    user = useCurrentUser(),
    cache = useQueryClient(),
    router = useRouter()

  const owner = user.data?.id
  const [file, setFile] = useState<File>()
  const [fileIssue, setFileIssue] = useState<string>()
  const [error, setError] = useState<string>()
  const [progress, setProgress] = useState<number | null>(null)
  const [active, setActive] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const busy = useRef(false),
    attempt = useRef(new UploadAttempt())
  const picker = useRef<HTMLInputElement>(null),
    summary = useRef<HTMLDivElement>(null)
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<UploadMetadata>({
    resolver: zodResolver(uploadFormSchema),
    defaultValues: {
      title: "",
      documentType: "OTHER",
      issuer: "",
      referenceNumber: "",
      documentDate: "",
      expirationDate: "",
      categoryId: "",
      tagIds: [],
    },
  })
  const authenticated = async <T,>(read: () => Promise<T>) => {
    try {
      return await read()
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401)
        cache.setQueryData(userKey, null)
      throw reason
    }
  }

  const categories = useInfiniteQuery({
    queryKey: ["categories", owner],
    enabled: !!owner,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      authenticated(() => listCategories(api, pageParam)),
    getNextPageParam: (last) =>
      last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined,
  })

  const tags = useInfiniteQuery({
    queryKey: ["tags", owner],
    enabled: !!owner,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => authenticated(() => listTags(api, pageParam)),
    getNextPageParam: (last) =>
      last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined,
  })

  const categoryItems =
      categories.data?.pages.flatMap((page) => page.data) ?? [],
    tagItems = tags.data?.pages.flatMap((page) => page.data) ?? []
  const mutation = useMutation({
    mutationFn: ({
      selected,
      values,
      key,
      signal,
    }: {
      selected: File
      values: UploadMetadata
      key: string
      signal: AbortSignal
    }) =>
      uploadDocument(api, selected, values, key, {
        signal,
        onProgress: setProgress,
      }),
    retry: false,
  })

  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    if (!active) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    const link = (event: MouseEvent) => {
      const anchor =
        event.target instanceof Element ? event.target.closest("a[href]") : null
      if (
        anchor &&
        !window.confirm(
          "An upload is running. Leave and cancel the browser request? The server may already have saved it."
        )
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener("beforeunload", warn)
    document.addEventListener("click", link, true)
    return () => {
      window.removeEventListener("beforeunload", warn)
      document.removeEventListener("click", link, true)
    }
  }, [active])
  function select(files: FileList | File[]) {
    if (busy.current) return
    attempt.current.reset()
    setProgress(null)
    setError(undefined)
    const selected = files.length === 1 ? files[0] : undefined
    setFile(selected)
    setFileIssue(
      files.length > 1
        ? "Choose exactly one file."
        : fileError(selected, maxBytes)
    )
  }
  async function submit(values: UploadMetadata) {
    if (busy.current) return
    const issue = fileError(file, maxBytes)
    if (issue || !file) {
      setFileIssue(issue)
      picker.current?.focus()
      return
    }
    if (
      (values.categoryId &&
        !categoryItems.some((item) => item.id === values.categoryId)) ||
      values.tagIds.some((id) => !tagItems.some((item) => item.id === id))
    ) {
      setError("Choose categories and tags from the loaded options.")
      return
    }
    busy.current = true
    setActive(true)
    setError(undefined)
    setProgress(null)
    controller.current = new AbortController()
    try {
      const receipt = await mutation.mutateAsync({
        selected: file,
        values,
        key: attempt.current.key(file, values),
        signal: controller.current.signal,
      })
      cache.setQueryData(["upload-success", owner], {
        id: receipt.id,
        status: receipt.status,
      })
      await cache.invalidateQueries({ queryKey: ["documents", owner] })
      router.push("/documents")
    } catch (reason) {
      setError(uploadError(reason))
      if (reason instanceof ApiError && reason.status === 401)
        cache.setQueryData(userKey, null)
      requestAnimationFrame(() => summary.current?.focus())
    } finally {
      busy.current = false
      setActive(false)
      controller.current = null
    }
  }
  if (!owner)
    return (
      <p role="status">
        <Spinner aria-hidden className="mr-2 inline size-4" />
        Checking your session…
      </p>
    )

  return (
    <div className="min-w-0 space-y-4">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Upload document
        </h1>
        <p className="mt-2 text-muted-foreground">
          Save an original PDF, JPEG or PNG. Fields marked * are required.
        </p>
      </div>
      <form
        noValidate
        onSubmit={(event) =>
          void handleSubmit(submit, () => {
            if (!file) {
              setFileIssue("Choose one file.")
              picker.current?.focus()
            }
          })(event)
        }
        className="space-y-6"
      >
        <fieldset disabled={active} className="min-w-0 space-y-6">
          <legend className="sr-only">Document file and metadata</legend>
          <div
            className="space-y-4 rounded-xl border-2 border-dashed border-input bg-card p-6 transition-colors focus-within:border-primary hover:border-primary/60 sm:p-8"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              select(event.dataTransfer.files)
            }}
          >
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Upload aria-hidden />
            </div>
            <FieldLabel htmlFor="upload-file" className="block font-medium">
              File *
            </FieldLabel>
            <p id="file-hint" className="text-sm text-muted-foreground">
              Drop one file here or use the file picker. Maximum{" "}
              {formatBytes(maxBytes)}. The server validates the actual content.
            </p>
            <Input
              ref={picker}
              id="upload-file"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              aria-invalid={!!fileIssue}
              aria-describedby={`file-hint${fileIssue ? " file-error" : ""}`}
              className="h-auto min-h-11 py-2"
              onChange={(event) => {
                if (event.target.files?.length) select(event.target.files)
                event.target.value = ""
              }}
            />
            {file && (
              <div className="space-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
                <p className="break-all">{file.name}</p>
                <p>
                  {file.type || "Unknown type"} · {formatBytes(file.size)}
                </p>
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => picker.current?.click()}
                  >
                    Replace file
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => select([])}
                  >
                    Remove file
                  </Button>
                </div>
              </div>
            )}
            {fileIssue && (
              <FieldError
                id="file-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {fileIssue}
              </FieldError>
            )}
          </div>
          <Card>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <TextField
                name="title"
                label="Title *"
                max={300}
                register={register}
                errors={errors}
              />
              <TextField
                name="documentType"
                label="Document type *"
                max={50}
                register={register}
                errors={errors}
              />
              <TextField
                name="issuer"
                label="Issuer (optional)"
                max={200}
                register={register}
                errors={errors}
              />
              <TextField
                name="referenceNumber"
                label="Reference number (optional)"
                max={200}
                register={register}
                errors={errors}
              />
              <DatePickerControl
                name="documentDate"
                label="Document date (optional)"
                disabled={active}
                control={control}
              />
              <DatePickerControl
                name="expirationDate"
                label="Expiration date (optional)"
                disabled={active}
                control={control}
              />
              <div className="space-y-2">
                <SelectField
                  name="categoryId"
                  label="Category (optional)"
                  control={control}
                  disabled={
                    active || categories.isPending || categories.isError
                  }
                  items={[
                    { value: "", label: "No category" },
                    ...categoryItems.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                />
                {categories.isPending && (
                  <p role="status">
                    <Spinner aria-hidden className="mr-2 inline size-4" />
                    Loading categories…
                  </p>
                )}
                {categories.isError && (
                  <Alert variant="destructive">
                    Categories unavailable.{" "}
                    <Button
                      type="button"
                      variant="link"
                      onClick={() => void categories.refetch()}
                    >
                      Retry categories
                    </Button>
                  </Alert>
                )}
                {categories.hasNextPage && (
                  <Button
                    type="button"
                    variant="link"
                    disabled={active || categories.isFetching}
                    onClick={() => void categories.fetchNextPage()}
                  >
                    Load more categories
                  </Button>
                )}
              </div>
              <div className="space-y-2">
                <SelectField
                  name="tagIds"
                  label="Tags (optional)"
                  control={control}
                  disabled={active || tags.isPending || tags.isError}
                  items={tagItems.map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                />
                {tags.isPending && (
                  <p role="status">
                    <Spinner aria-hidden className="mr-2 inline size-4" />
                    Loading tags…
                  </p>
                )}
                {tags.isError && (
                  <Alert variant="destructive">
                    Tags unavailable.{" "}
                    <Button
                      type="button"
                      variant="link"
                      onClick={() => void tags.refetch()}
                    >
                      Retry tags
                    </Button>
                  </Alert>
                )}
                {!tags.isPending && !tags.isError && !tagItems.length && (
                  <p className="text-sm text-muted-foreground">
                    No tags available.
                  </p>
                )}
                {tags.hasNextPage && (
                  <Button
                    type="button"
                    variant="link"
                    disabled={active || tags.isFetching}
                    onClick={() => void tags.fetchNextPage()}
                  >
                    Load more tags
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </fieldset>
        <Card className="flex-row flex-wrap items-center gap-3 p-4">
          {error && (
            <Alert
              variant="destructive"
              ref={summary}
              tabIndex={-1}
              role="alert"
              className="rounded-lg border border-destructive/30 p-4 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            >
              {error}
            </Alert>
          )}
          {active && (
            <div className="space-y-2" aria-live="polite">
              <p role="status">
                <Spinner aria-hidden className="mr-2 inline size-4" />
                {progress === 100
                  ? "File sent. Waiting for server validation and confirmation…"
                  : progress === null
                    ? "Uploading document…"
                    : `Uploading document… ${progress}%`}
              </p>
              <Progress
                aria-label="Document upload progress"
                className="h-3 w-full accent-primary"
                max={100}
                value={progress}
              />
            </div>
          )}

          <Button type="submit" disabled={active}>
            <Upload aria-hidden />
            {active ? "Uploading…" : "Upload document"}
          </Button>
          {active && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => controller.current?.abort()}
            >
              Cancel upload
            </Button>
          )}
          <Link
            href="/documents"
            className={`${buttonVariants({ variant: "outline" })} mx-2`}
          >
            Back to documents
          </Link>
        </Card>
      </form>
    </div>
  )
}
