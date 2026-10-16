"use client"
import { useEffect, useId, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuthApi, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import {
  suggestSearch,
  type SearchFilters,
  type Suggestion,
} from "@/lib/api/search"

export function SearchInput({
  value,
  filters,
  change,
  dismissKey,
}: {
  value: string
  filters: SearchFilters
  change: (value: string) => void
  dismissKey: number
}) {
  const api = useAuthApi(),
    cache = useQueryClient(),
    id = useId()
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [active, setActive] = useState(-1),
    [focused, setFocused] = useState(false),
    [unavailable, setUnavailable] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const [dismissed, setDismissed] = useState("")
  const [responseKey, setResponseKey] = useState("")
  const requestKey = JSON.stringify([value, filters, dismissKey])
  useEffect(() => {
    const controller = new AbortController()
    const prefix = value.normalize("NFC").trim()
    const timer = setTimeout(() => {
      setSuggestions([])
      setActive(-1)
      setUnavailable(false)
      if (
        !focused ||
        dismissed === requestKey ||
        prefix.length < 2 ||
        prefix.length > 200
      )
        return
      void Promise.resolve()
        .then(() => suggestSearch(api, prefix, filters, controller.signal))
        .then((response) => {
          if (!controller.signal.aborted) {
            setSuggestions(response.suggestions)
            setResponseKey(requestKey)
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          if (error instanceof ApiError && error.status === 401)
            cache.setQueryData(userKey, null)
          setUnavailable(true)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, cache, value, filters, focused, dismissed, requestKey])
  const open =
    focused &&
    responseKey === requestKey &&
    dismissed !== requestKey &&
    suggestions.length > 0
  function select(suggestion: Suggestion) {
    change(suggestion.text)
    setSuggestions([])
    setActive(-1)
    setFocused(false)
    input.current?.focus()
  }
  return (
    <div className="relative min-w-0 flex-1 space-y-2">
      <Label htmlFor={id}>Search query</Label>
      <Input
        ref={input}
        id={id}
        value={value}
        maxLength={4000}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={
          open && active >= 0 ? `${id}-${active}` : undefined
        }
        autoComplete="off"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setFocused(true)
          setSuggestions([])
          setActive(-1)
          change(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            setDismissed(requestKey)
            setSuggestions([])
          } else if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault()
            setActive((i) =>
              i < 0
                ? e.key === "ArrowDown"
                  ? 0
                  : suggestions.length - 1
                : (i + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) %
                  suggestions.length
            )
          } else if (open && e.key === "Enter" && active >= 0) {
            e.preventDefault()
            select(suggestions[active])
          }
        }}
      />
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label="Private suggestions"
          className="absolute z-20 mt-1 w-full rounded-md border bg-popover p-1 shadow-md"
        >
          {suggestions.map((s, i) => (
            <li
              key={`${s.documentId}:${s.type}:${s.text}`}
              role="option"
              id={`${id}-${i}`}
              aria-selected={i === active}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => select(s)}
              className={`cursor-pointer rounded-sm p-2 text-sm break-words ${i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent"}`}
            >
              {s.text}
              <span className="ml-2 text-xs text-muted-foreground">
                {s.type === "referenceNumber" ? "reference" : s.type}
              </span>
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only" role="status">
        {open
          ? `${suggestions.length} private suggestions available. Use arrow keys to select.`
          : unavailable
            ? "Suggestions unavailable. You can still submit your search."
            : ""}
      </span>
    </div>
  )
}
