"use client"

import * as React from "react"
import { format, parse } from "date-fns"
import { XIcon } from "lucide-react"
import { Control, FieldPath, FieldValues, useController } from "react-hook-form"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Field, FieldLabel, FieldError } from "@/components/ui/field"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

type DatePickerProps<T extends FieldValues> = {
  name: FieldPath<T>
  control: Control<T>
  id?: string
  label?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  calendarProps?: Omit<
    React.ComponentProps<typeof Calendar>,
    "mode" | "selected" | "onSelect"
  >
}

export function DatePickerControl<T extends FieldValues>({
  name,
  control,
  id,
  label,
  placeholder = "Pick a date",
  disabled,
  className,
  calendarProps,
}: DatePickerProps<T>) {
  const generatedId = React.useId()
  const fieldId = id ?? generatedId

  const {
    field: { value, onChange, onBlur, ref: inputRef },
    fieldState,
  } = useController({
    name,
    control,
  })

  // Form value: "yyyy-MM-dd" -> Calendar value: Date
  const [open, setOpen] = React.useState(false)
  const selectedDate = value
    ? parse(value, "yyyy-MM-dd", new Date())
    : undefined

  const handleSelect = (date: Date | undefined) => {
    onChange(date ? format(date, "yyyy-MM-dd") : "")
    setOpen(false)
  }

  const handleClear = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()

    onChange("")
  }

  return (
    <Field className={className} data-invalid={fieldState.invalid}>
      {label && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}

      <Popover open={open} onOpenChange={setOpen}>
        <div className="relative">
          <PopoverTrigger
            render={
              <Button
                type="button"
                id={fieldId}
                variant="outline"
                disabled={disabled}
                ref={inputRef}
                onBlur={onBlur}
                aria-describedby={
                  fieldState.error ? `${fieldId}-error` : undefined
                }
                aria-invalid={fieldState.invalid}
                className="w-full justify-start pr-9 font-normal"
              >
                {value ? (
                  value
                ) : (
                  <span className="text-muted-foreground">{placeholder}</span>
                )}
              </Button>
            }
          />

          {value && !disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleClear}
              aria-label={`Clear ${label ?? "date"}`}
              className="absolute top-1/2 right-1 size-7 -translate-y-1/2"
            >
              <XIcon className="size-4" />
            </Button>
          )}
        </div>

        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            {...calendarProps}
            mode="single"
            selected={selectedDate}
            onSelect={handleSelect}
            defaultMonth={selectedDate}
          />
        </PopoverContent>
      </Popover>

      {fieldState.error && (
        <FieldError id={`${fieldId}-error`}>
          {fieldState.error.message}
        </FieldError>
      )}
    </Field>
  )
}
