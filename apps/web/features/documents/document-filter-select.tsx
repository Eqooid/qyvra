"use client"

import { useId } from "react"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function DocumentFilterSelect({
  title,
  value,
  options,
  disabled,
  compact = false,
  onChange,
}: {
  title: string
  value: string
  options: { value: string; label: string }[]
  disabled?: boolean
  compact?: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <Field className="min-w-0">
      <FieldLabel htmlFor={id} className={compact ? "sr-only" : undefined}>
        {title}
      </FieldLabel>
      <Select
        items={options}
        value={value}
        disabled={disabled}
        onValueChange={(next) => onChange(next ?? "")}
      >
        <SelectTrigger id={id} className="w-full min-w-0">
          <SelectValue className="truncate" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            <SelectLabel>{title}</SelectLabel>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="truncate">{option.label}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}
