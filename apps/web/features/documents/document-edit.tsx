"use client"
import { Spinner } from "@/components/ui/spinner"

import { Checkbox } from "@/components/ui/checkbox"
import { DatePickerControl } from "@/components/shared/date-picker-control"

import { Alert } from "@/components/ui/alert"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel, FieldError } from "@/components/ui/field"
import { Card } from "@/components/ui/card"

import { useEffect, useRef } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { useAuthApi, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import {
  DocumentDetail,
  listCategories,
  listTags,
  updateDocument,
  documentActionError,
} from "@/lib/api/documents"
import { UploadMetadata } from "@/lib/api/upload"
import { uploadFormSchema } from "./upload-validation"
import { editDefaults, metadataPatch } from "./edit-metadata"

export function DocumentEdit({
  document,
  owner,
  saved,
  close,
}: {
  document: DocumentDetail
  owner: string
  saved: (document: DocumentDetail) => Promise<void>
  close: () => void
}) {
  const api = useAuthApi(),
    cache = useQueryClient(),
    busy = useRef(false)
  const {
    register,
    control,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<UploadMetadata>({
    resolver: zodResolver(uploadFormSchema),
    defaultValues: editDefaults(document),
  })
  useEffect(() => {
    setFocus("title")
  }, [setFocus])
  useEffect(() => {
    if (!isDirty) return
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    const click = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("a[href]") &&
        !window.confirm("Discard unsaved metadata changes?")
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener("beforeunload", unload)
    window.document.addEventListener("click", click, true)
    return () => {
      window.removeEventListener("beforeunload", unload)
      window.document.removeEventListener("click", click, true)
    }
  }, [isDirty])
  const read = async <T,>(call: () => Promise<T>) => {
    try {
      return await call()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        cache.setQueryData(userKey, null)
      throw error
    }
  }
  const categories = useInfiniteQuery({
    queryKey: ["categories", owner],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => read(() => listCategories(api, pageParam)),
    getNextPageParam: (last) =>
      last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined,
  })
  const tags = useInfiniteQuery({
    queryKey: ["tags", owner],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => read(() => listTags(api, pageParam)),
    getNextPageParam: (last) =>
      last.meta.hasMore ? (last.meta.nextCursor ?? undefined) : undefined,
  })
  const categoryItems = [
    ...new Map(
      [
        ...(document.category ? [document.category] : []),
        ...(categories.data?.pages.flatMap((page) => page.data) ?? []),
      ].map((item) => [item.id, item])
    ).values(),
  ]
  const tagItems = [
    ...new Map(
      [
        ...document.tags,
        ...(tags.data?.pages.flatMap((page) => page.data) ?? []),
      ].map((item) => [item.id, item])
    ).values(),
  ]
  async function submit(values: UploadMetadata) {
    if (busy.current) return
    const patch = metadataPatch(document, values)
    if (!Object.keys(patch).length) {
      setError("root", { message: "No changes to save." })
      return
    }
    if (
      (values.categoryId &&
        !categoryItems.some((item) => item.id === values.categoryId)) ||
      values.tagIds.some((id) => !tagItems.some((item) => item.id === id))
    ) {
      setError("root", {
        message: "Choose from the available category and tag options.",
      })
      return
    }
    busy.current = true
    try {
      await saved(await read(() => updateDocument(api, document.id, patch)))
    } catch (error) {
      setError("root", { message: documentActionError(error) })
    } finally {
      busy.current = false
    }
  }
  return (
    <Card aria-labelledby="edit-heading" className="space-y-4 p-5">
      <h2 id="edit-heading" className="text-xl font-semibold tracking-tight">
        Edit metadata
      </h2>
      <p className="text-sm text-muted-foreground">
        Blank optional fields are cleared. Only changed fields are saved.
      </p>
      <form
        noValidate
        onSubmit={(event) => void handleSubmit(submit)(event)}
        className="space-y-4"
      >
        <fieldset
          disabled={isSubmitting}
          className="grid min-w-0 gap-4 sm:grid-cols-2"
        >
          <legend className="sr-only">Editable document metadata</legend>
          {(
            [
              { name: "title", label: "Title *", max: 300 },
              { name: "documentType", label: "Document type *", max: 50 },
              { name: "issuer", label: "Issuer (optional)", max: 200 },
              {
                name: "referenceNumber",
                label: "Reference number (optional)",
                max: 200,
              },
              {
                name: "documentDate",
                label: "Document date (optional)",
                date: true,
              },
              {
                name: "expirationDate",
                label: "Expiration date (optional)",
                date: true,
              },
            ] as const
          ).map((field) =>
            "date" in field ? (
              <DatePickerControl
                key={field.name}
                name={field.name}
                id={`edit-${field.name}`}
                label={field.label}
                control={control}
                disabled={isSubmitting}
              />
            ) : (
              <Field key={field.name} className="min-w-0 space-y-2">
                <FieldLabel
                  htmlFor={`edit-${field.name}`}
                  className="text-sm font-medium"
                >
                  {field.label}
                </FieldLabel>
                <Input
                  id={`edit-${field.name}`}
                  type="text"
                  maxLength={"max" in field ? field.max : undefined}
                  className="w-full"
                  {...register(field.name)}
                  aria-invalid={!!errors[field.name]}
                  aria-describedby={
                    errors[field.name] ? `edit-${field.name}-error` : undefined
                  }
                />
                {errors[field.name] && (
                  <FieldError
                    id={`edit-${field.name}-error`}
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {errors[field.name]?.message}
                  </FieldError>
                )}
              </Field>
            )
          )}
          <Field className="space-y-2">
            <FieldLabel htmlFor="edit-category" className="text-sm font-medium">
              Category (optional)
            </FieldLabel>
            <NativeSelect
              id="edit-category"
              className="w-full"
              {...register("categoryId")}
            >
              <NativeSelectOption value="">No category</NativeSelectOption>
              {categoryItems.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {categories.isPending && (
              <p role="status">
                <Spinner aria-hidden className="mr-2 inline size-4" />
                Loading categories…
              </p>
            )}
            {categories.isError && (
              <Alert variant="destructive" role="alert">
                Category options unavailable. Existing selection is preserved.{" "}
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
                disabled={categories.isFetching}
                onClick={() => void categories.fetchNextPage()}
              >
                Load more categories
              </Button>
            )}
          </Field>
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm font-medium">Tags (optional)</legend>
            <div className="max-h-48 space-y-2 overflow-auto rounded-lg border p-3">
              {tagItems.map((tag) => (
                <FieldLabel
                  key={tag.id}
                  className="flex min-h-9 items-center gap-3 text-sm"
                >
                  <Controller
                    name="tagIds"
                    control={control}
                    render={({ field, fieldState }) => (
                      <Checkbox
                        checked={field.value.includes(tag.id)}
                        disabled={isSubmitting}
                        onCheckedChange={(checked) =>
                          field.onChange(
                            checked
                              ? [...field.value, tag.id]
                              : field.value.filter((id) => id !== tag.id)
                          )
                        }
                        ref={field.ref}
                        onBlur={field.onBlur}
                        aria-invalid={fieldState.invalid}
                        aria-describedby={
                          fieldState.error ? "edit-tags-error" : undefined
                        }
                      />
                    )}
                  />
                  <span className="break-words">{tag.name}</span>
                </FieldLabel>
              ))}
              {!tags.isPending && !tags.isError && !tagItems.length && (
                <p className="text-sm text-muted-foreground">
                  No tags available.
                </p>
              )}
            </div>
            {tags.isPending && (
              <p role="status">
                <Spinner aria-hidden className="mr-2 inline size-4" />
                Loading tags…
              </p>
            )}
            {tags.isError && (
              <Alert variant="destructive" role="alert">
                Tag options unavailable. Existing selections are preserved.{" "}
                <Button
                  type="button"
                  variant="link"
                  onClick={() => void tags.refetch()}
                >
                  Retry tags
                </Button>
              </Alert>
            )}
            {tags.hasNextPage && (
              <Button
                type="button"
                variant="link"
                disabled={tags.isFetching}
                onClick={() => void tags.fetchNextPage()}
              >
                Load more tags
              </Button>
            )}
            {errors.tagIds && (
              <FieldError id="edit-tags-error">
                {errors.tagIds.message}
              </FieldError>
            )}
          </fieldset>
        </fieldset>
        {errors.root && (
          <FieldError role="alert" className="text-sm text-destructive">
            {errors.root.message}
          </FieldError>
        )}
        {isSubmitting && (
          <p role="status">
            <Spinner aria-hidden className="mr-2 inline size-4" />
            Saving metadata…
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={isSubmitting}>
            Save changes
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => {
              if (
                !isDirty ||
                window.confirm("Discard unsaved metadata changes?")
              )
                close()
            }}
          >
            Cancel editing
          </Button>
        </div>
      </form>
    </Card>
  )
}
