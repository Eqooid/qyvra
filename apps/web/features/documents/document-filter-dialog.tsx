"use client"

import { useState } from "react"
import { useForm, useWatch } from "react-hook-form"
import { ListFilter, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelectOption } from "@/components/ui/native-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { DatePickerControl } from "@/components/shared/date-picker-control"
import {
  type DocumentQuery,
  documentMimeTypeSchema,
  statuses,
} from "@/lib/api/documents"
import { DocumentFilterSelect } from "./document-filter-select"

type Lookup = { id: string; name: string }
type FilterDraft = {
  filename: string
  mimeType: string
  documentType: string
  status: string
  categoryId: string
  tagIds: string[]
  archived: string
  createdFrom: string
  createdTo: string
  updatedFrom: string
  updatedTo: string
}

const emptyDraft = (): FilterDraft => ({
  filename: "",
  mimeType: "",
  documentType: "",
  status: "",
  categoryId: "",
  tagIds: [],
  archived: "",
  createdFrom: "",
  createdTo: "",
  updatedFrom: "",
  updatedTo: "",
})

function fromQuery(query: DocumentQuery): FilterDraft {
  return {
    filename: query.filename ?? "",
    mimeType: query.mimeType ?? "",
    documentType: query.documentType ?? "",
    status: query.status ?? "",
    categoryId: query.categoryId ?? "",
    tagIds: [...(query.tagIds ?? (query.tagId ? [query.tagId] : []))],
    archived: query.archived ?? "",
    createdFrom: query.createdFrom ?? "",
    createdTo: query.createdTo ?? "",
    updatedFrom: query.updatedFrom ?? "",
    updatedTo: query.updatedTo ?? "",
  }
}

export function advancedFilterCount(query: DocumentQuery) {
  return [
    query.filename,
    query.mimeType,
    query.documentType,
    query.status,
    query.categoryId,
    query.tagId || query.tagIds?.length,
    query.archived,
    query.createdFrom || query.createdTo,
    query.updatedFrom || query.updatedTo,
  ].filter(Boolean).length
}

export function DocumentFilterDialog({
  query,
  categories,
  tags,
  categoriesPending,
  tagsPending,
  categoriesError,
  tagsError,
  categoriesMore,
  tagsMore,
  categoriesFetching,
  tagsFetching,
  retryCategories,
  retryTags,
  loadCategories,
  loadTags,
  apply,
}: {
  query: DocumentQuery
  categories: Lookup[]
  tags: Lookup[]
  categoriesPending: boolean
  tagsPending: boolean
  categoriesError: boolean
  tagsError: boolean
  categoriesMore: boolean
  tagsMore: boolean
  categoriesFetching: boolean
  tagsFetching: boolean
  retryCategories: () => void
  retryTags: () => void
  loadCategories: () => void
  loadTags: () => void
  apply: (filters: Partial<DocumentQuery>) => void
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { control, register, reset, setValue, getValues } =
    useForm<FilterDraft>({
      defaultValues: fromQuery(query),
    })
  const draft = useWatch({ control })
  const selectedTags = draft.tagIds ?? []
  const types = [
    "INVOICE",
    "RECEIPT",
    "STATEMENT",
    "CONTRACT",
    "CERTIFICATE",
    "WARRANTY",
    "INSURANCE",
    "IDENTITY",
    "OTHER",
  ]
  if (draft.documentType && !types.includes(draft.documentType))
    types.push(draft.documentType)

  function setOpenFromDialog(next: boolean) {
    if (next) reset(fromQuery(query))
    setError(null)
    setOpen(next)
  }

  function submit() {
    const values = getValues()
    const documentType = values.documentType.trim().toUpperCase()
    if (documentType && !/^[A-Z][A-Z0-9_]{0,49}$/.test(documentType)) {
      setError(
        "Document type must use up to 50 uppercase letters, numbers or underscores."
      )
      return
    }
    if (
      (values.createdFrom &&
        values.createdTo &&
        values.createdFrom > values.createdTo) ||
      (values.updatedFrom &&
        values.updatedTo &&
        values.updatedFrom > values.updatedTo)
    ) {
      setError("The start date must be on or before the end date.")
      return
    }
    setError(null)
    const mimeType = documentMimeTypeSchema.safeParse(values.mimeType)
    apply({
      filename: values.filename.trim() || undefined,
      mimeType: mimeType.success ? mimeType.data : undefined,
      documentType: documentType || undefined,
      status: statuses.find((status) => status === values.status),
      categoryId: values.categoryId || undefined,
      tagId: undefined,
      tagIds: values.tagIds.length ? values.tagIds : undefined,
      archived:
        values.archived === "true" || values.archived === "false"
          ? values.archived
          : undefined,
      createdFrom: values.createdFrom || undefined,
      createdTo: values.createdTo || undefined,
      updatedFrom: values.updatedFrom || undefined,
      updatedTo: values.updatedTo || undefined,
    })
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpenFromDialog}>
      <DialogTrigger
        render={
          <Button variant="outline" className="shrink-0" aria-label="Filters" />
        }
      >
        <ListFilter aria-hidden />
        Filters
        {advancedFilterCount(query) > 0 && (
          <Badge
            variant="secondary"
            className="ml-1 min-w-5 justify-center px-1"
          >
            {advancedFilterCount(query)}
          </Badge>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Filter documents</DialogTitle>
          <DialogDescription>
            Narrow the document list. Changes appear after you apply them.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <section className="space-y-3" aria-labelledby="filter-file-heading">
            <h3 id="filter-file-heading" className="font-medium">
              File
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="document-filename-filter">
                  Current filename
                </FieldLabel>
                <Input
                  id="document-filename-filter"
                  placeholder="Search current filename..."
                  maxLength={200}
                  {...register("filename")}
                />
              </Field>
              <DocumentFilterSelect
                title="Current file type"
                value={draft.mimeType ?? ""}
                options={[
                  { value: "", label: "All file types" },
                  ...documentMimeTypeSchema.options.map((value) => ({
                    value,
                    label:
                      value === "application/pdf"
                        ? "PDF"
                        : value === "image/jpeg"
                          ? "JPEG image"
                          : "PNG image",
                  })),
                ]}
                onChange={(value) => setValue("mimeType", value)}
              />
              <Field>
                <FieldLabel htmlFor="document-type-filter">
                  Document type
                </FieldLabel>
                <Input
                  id="document-type-filter"
                  list="document-types"
                  placeholder="All types"
                  maxLength={50}
                  {...register("documentType")}
                />
                <datalist id="document-types">
                  {types.map((type) => (
                    <NativeSelectOption key={type} value={type} />
                  ))}
                </datalist>
              </Field>
              <DocumentFilterSelect
                title="Status"
                value={draft.status ?? ""}
                options={[
                  { value: "", label: "All statuses" },
                  ...statuses.map((status) => ({
                    value: status,
                    label: status.toLowerCase().replaceAll("_", " "),
                  })),
                ]}
                onChange={(value) => setValue("status", value)}
              />
            </div>
          </section>
          <Separator />
          <section
            className="space-y-3"
            aria-labelledby="filter-organization-heading"
          >
            <h3 id="filter-organization-heading" className="font-medium">
              Organization
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="min-w-0">
                <DocumentFilterSelect
                  title="Category"
                  value={draft.categoryId ?? ""}
                  disabled={categoriesPending || categoriesError}
                  options={[
                    {
                      value: "",
                      label: categoriesPending
                        ? "Loading categories..."
                        : "All categories",
                    },
                    ...(draft.categoryId &&
                    !categories.some((item) => item.id === draft.categoryId)
                      ? [
                          {
                            value: draft.categoryId,
                            label: "Selected category (not loaded)",
                          },
                        ]
                      : []),
                    ...categories.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                  onChange={(value) => setValue("categoryId", value)}
                />
                {categoriesError && (
                  <p role="alert" className="text-sm text-destructive">
                    Categories unavailable.{" "}
                    <Button variant="link" onClick={retryCategories}>
                      Retry categories
                    </Button>
                  </p>
                )}
                {categoriesMore && (
                  <Button
                    variant="link"
                    disabled={categoriesFetching}
                    onClick={loadCategories}
                  >
                    Load more categories
                  </Button>
                )}
              </div>
              <DocumentFilterSelect
                title="Archive state"
                value={draft.archived ?? ""}
                options={[
                  { value: "", label: "Active and archived" },
                  { value: "false", label: "Not archived" },
                  { value: "true", label: "Archived" },
                ]}
                onChange={(value) => setValue("archived", value)}
              />
            </div>
            <Field>
              <FieldLabel htmlFor="document-tags-filter">
                Tags (match all)
              </FieldLabel>
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      id="document-tags-filter"
                      aria-label="Tags (match all)"
                      variant="outline"
                      disabled={tagsPending || tagsError}
                      className="w-full justify-start font-normal"
                    />
                  }
                >
                  {selectedTags.length
                    ? `${selectedTags.length} selected · match all`
                    : "All tags"}
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="max-h-72 overflow-y-auto"
                >
                  <p className="mb-2 text-xs text-muted-foreground">
                    Documents must contain all selected tags (up to 10).
                  </p>
                  {tags.map((tag) => (
                    <label
                      key={tag.id}
                      className="flex min-h-9 items-center gap-3 px-1 text-sm"
                    >
                      <Checkbox
                        checked={selectedTags.includes(tag.id)}
                        disabled={
                          selectedTags.length >= 10 &&
                          !selectedTags.includes(tag.id)
                        }
                        onCheckedChange={(checked) =>
                          setValue(
                            "tagIds",
                            checked
                              ? [...selectedTags, tag.id]
                              : selectedTags.filter((id) => id !== tag.id)
                          )
                        }
                      />
                      <span className="break-words">{tag.name}</span>
                    </label>
                  ))}
                  {!tags.length && (
                    <p className="text-sm text-muted-foreground">
                      No tags available.
                    </p>
                  )}
                </PopoverContent>
              </Popover>
              {!!selectedTags.length && (
                <div className="flex flex-wrap gap-1.5">
                  {selectedTags.map((id) => (
                    <Badge
                      key={id}
                      variant="secondary"
                      className="max-w-full gap-1"
                    >
                      <span className="max-w-44 truncate">
                        {tags.find((tag) => tag.id === id)?.name ??
                          "Selected tag"}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${tags.find((tag) => tag.id === id)?.name ?? "selected"} tag`}
                        onClick={() =>
                          setValue(
                            "tagIds",
                            selectedTags.filter((selected) => selected !== id)
                          )
                        }
                      >
                        <X aria-hidden />
                      </Button>
                    </Badge>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Documents must contain every selected tag.
              </p>
            </Field>
            {tagsError && (
              <p role="alert" className="text-sm text-destructive">
                Tags unavailable.{" "}
                <Button variant="link" onClick={retryTags}>
                  Retry tags
                </Button>
              </p>
            )}
            {tagsMore && (
              <Button variant="link" disabled={tagsFetching} onClick={loadTags}>
                Load more tags
              </Button>
            )}
          </section>
          <Separator />
          <section className="space-y-4" aria-labelledby="filter-dates-heading">
            <h3 id="filter-dates-heading" className="font-medium">
              Dates
            </h3>
            <div className="grid gap-5 sm:grid-cols-2 sm:gap-6">
              <div className="space-y-3">
                <h4 className="text-sm font-medium">Created date</h4>
                <div className="grid gap-3">
                  <DatePickerControl
                    name="createdFrom"
                    control={control}
                    label="Created from"
                  />
                  <DatePickerControl
                    name="createdTo"
                    control={control}
                    label="Created to"
                  />
                </div>
              </div>
              <div className="space-y-3">
                <h4 className="text-sm font-medium">Updated date</h4>
                <div className="grid gap-3">
                  <DatePickerControl
                    name="updatedFrom"
                    control={control}
                    label="Updated from"
                  />
                  <DatePickerControl
                    name="updatedTo"
                    control={control}
                    label="Updated to"
                  />
                </div>
              </div>
            </div>
          </section>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="sticky bottom-0 mt-1">
          <Button
            variant="ghost"
            onClick={() => {
              reset(emptyDraft())
              setError(null)
            }}
          >
            Clear
          </Button>
          <Button variant="outline" onClick={() => setOpenFromDialog(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Apply filters</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
