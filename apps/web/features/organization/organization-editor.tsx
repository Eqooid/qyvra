"use client"
import { Spinner } from "@/components/ui/spinner"

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel, FieldError } from "@/components/ui/field"

import { useRef } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Button } from "@/components/ui/button"
import {
  type OrganizationItem,
  type OrganizationKind,
  type OrganizationInput,
} from "@/lib/api/organization"
import {
  colorOptions,
  normalizeName,
  organizationFormSchema,
  type OrganizationValues,
} from "./validation"
import { iconOptions } from "./category-style"

export function OrganizationEditor({
  kind,
  item,
  close,
  save,
  returnFocus,
}: {
  kind: OrganizationKind
  item: OrganizationItem | null
  close: () => void
  save: (input: OrganizationInput, id?: string) => Promise<void>
  returnFocus: React.RefObject<HTMLButtonElement | null>
}) {
  const noun = kind === "categories" ? "category" : "tag"
  const defaults = {
    name: item?.name ?? "",
    color: item?.color ?? "",
    icon: item?.icon ?? "",
  }
  const busy = useRef(false)
  const {
    register,
    handleSubmit,
    control: formControl,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<OrganizationValues>({
    resolver: zodResolver(organizationFormSchema),
    defaultValues: defaults,
  })
  const values = useWatch({ control: formControl })
  const unchanged =
    !!item &&
    normalizeName(values.name ?? "") === normalizeName(defaults.name) &&
    (kind === "tags" ||
      ((values.color ?? "").toLowerCase() === defaults.color.toLowerCase() &&
        values.icon === defaults.icon))
  async function submit(value: OrganizationValues) {
    if (busy.current || unchanged) return
    busy.current = true
    try {
      await save(
        {
          name: value.name,
          ...(kind === "categories"
            ? {
                color: value.color ? value.color.toLowerCase() : null,
                icon: value.icon || null,
              }
            : {}),
        },
        item?.id
      )
    } catch (error) {
      setError("root", {
        message: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      busy.current = false
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy.current) close()
      }}
    >
      <DialogContent
        finalFocus={returnFocus}
        showCloseButton={false}
        className="max-h-[90svh] overflow-y-auto"
      >
        <DialogTitle className="text-xl font-semibold">
          {item
            ? kind === "categories"
              ? "Edit category"
              : "Rename tag"
            : `Create ${noun}`}
        </DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          Names must be unique in your collection, ignoring capitalization. Use
          1–100 characters.
        </DialogDescription>
        <form
          noValidate
          onSubmit={(event) => void handleSubmit(submit)(event)}
          className="space-y-4"
          aria-busy={isSubmitting}
        >
          <Field className="space-y-2">
            <FieldLabel
              htmlFor="organization-name"
              className="text-sm font-medium"
            >
              Name *
            </FieldLabel>
            <Input
              id="organization-name"
              className="w-full"
              {...register("name")}
              disabled={isSubmitting}
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? "name-error" : undefined}
            />
            {errors.name && (
              <FieldError
                role="alert"
                id="name-error"
                className="text-sm text-destructive"
              >
                {errors.name.message}
              </FieldError>
            )}
          </Field>
          {kind === "categories" && (
            <>
              <Field className="space-y-2">
                <FieldLabel
                  htmlFor="organization-color"
                  className="text-sm font-medium"
                >
                  Color (optional)
                </FieldLabel>
                <NativeSelect
                  id="organization-color"
                  className="w-full"
                  {...register("color")}
                  disabled={isSubmitting}
                  aria-invalid={!!errors.color}
                  aria-describedby={errors.color ? "color-error" : undefined}
                >
                  <NativeSelectOption value="">
                    No custom color
                  </NativeSelectOption>
                  {defaults.color &&
                    !colorOptions.some(
                      (option) => option.value === defaults.color
                    ) && (
                      <NativeSelectOption value={defaults.color}>
                        Current color ({defaults.color})
                      </NativeSelectOption>
                    )}
                  {colorOptions.map((option) => (
                    <NativeSelectOption key={option.value} value={option.value}>
                      {option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {errors.color && (
                  <FieldError id="color-error" role="alert">
                    {errors.color.message}
                  </FieldError>
                )}
              </Field>
              <Field className="space-y-2">
                <FieldLabel
                  htmlFor="organization-icon"
                  className="text-sm font-medium"
                >
                  Icon (optional)
                </FieldLabel>
                <NativeSelect
                  id="organization-icon"
                  className="w-full"
                  {...register("icon")}
                  disabled={isSubmitting}
                  aria-invalid={!!errors.icon}
                  aria-describedby={errors.icon ? "icon-error" : undefined}
                >
                  <NativeSelectOption value="">Default icon</NativeSelectOption>
                  {defaults.icon &&
                    !Object.hasOwn(iconOptions, defaults.icon) && (
                      <NativeSelectOption value={defaults.icon}>
                        Current icon ({defaults.icon})
                      </NativeSelectOption>
                    )}
                  {Object.keys(iconOptions).map((icon) => (
                    <NativeSelectOption key={icon} value={icon}>
                      {icon.replaceAll("-", " ")}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {errors.icon && (
                  <FieldError id="icon-error" role="alert">
                    {errors.icon.message}
                  </FieldError>
                )}
              </Field>
            </>
          )}
          {errors.root && (
            <FieldError
              role="alert"
              className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
            >
              {errors.root.message}
            </FieldError>
          )}
          {isSubmitting && (
            <p role="status" className="text-sm text-muted-foreground">
              <Spinner aria-hidden className="mr-2 inline size-4" />
              Saving {noun}…
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={close}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || unchanged}>
              {item ? "Save changes" : `Create ${noun}`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
