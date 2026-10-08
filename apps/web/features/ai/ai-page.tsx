"use client"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQueryClient } from "@tanstack/react-query"
import { useAuthApi, useCurrentUser, userKey } from "@/features/auth/provider"
import { ApiError } from "@/lib/api/client"
import {
  aiError,
  aiQuestionSchema,
  askDocuments,
  semanticSearch,
  type Citation,
  type RagAnswer,
  type SemanticResult,
} from "@/lib/api/ai"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import { Alert } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { CitationSheet, SemanticResultCard } from "./source-components"

/** Only validated source IDs become interactive; unknown/model text remains literal. */
export function AnswerText({
  text,
  citations,
  open,
}: {
  text: string
  citations: Citation[]
  open: (citation: Citation, trigger: HTMLButtonElement) => void
}) {
  const known = new Map(citations.map((c) => [c.citationId, c]))
  return (
    <p className="text-sm leading-7 wrap-anywhere whitespace-pre-wrap">
      {text.split(/(\[S[1-9][0-9]*\])/g).map((part, i) => {
        const citation = known.get(part.slice(1, -1))
        return /^\[S[1-9][0-9]*\]$/.test(part) && citation ? (
          <Button
            key={i}
            type="button"
            size="sm"
            variant="outline"
            className="mx-1 inline-flex h-7 px-2 align-baseline"
            aria-label={`Source ${citation.citationId}`}
            onClick={(event) => open(citation, event.currentTarget)}
          >
            {part}
          </Button>
        ) : (
          <span key={i}>{part}</span>
        )
      })}
    </p>
  )
}
export function AiPage() {
  const user = useCurrentUser()
  return user.data ? (
    <AiWorkspace key={user.data.id} owner={user.data.id} />
  ) : (
    <p role="status">Checking your session…</p>
  )
}
export function AiWorkspace({ owner }: { owner: string }) {
  const api = useAuthApi(),
    cache = useQueryClient()
  const [mode, setMode] = useState<"search" | "ask">("search"),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [results, setResults] = useState<SemanticResult[] | null>(null),
    [answer, setAnswer] = useState<RagAnswer | null>(null),
    [selected, setSelected] = useState<{
      citation: Citation
      trigger: HTMLButtonElement
    } | null>(null)
  const active = useRef<AbortController | null>(null),
    sequence = useRef(0),
    busy = useRef(false)
  const form = useForm<{ question: string }>({
    resolver: zodResolver(aiQuestionSchema),
    defaultValues: { question: "" },
  })
  useEffect(
    () => () => {
      sequence.current++
      active.current?.abort()
    },
    []
  )
  function reset() {
    sequence.current++
    active.current?.abort()
    active.current = null
    busy.current = false
    setPending(false)
    setResults(null)
    setAnswer(null)
    setSelected(null)
    setError(undefined)
  }
  async function submit({ question }: { question: string }) {
    if (busy.current) return
    reset()
    busy.current = true
    setPending(true)
    const id = ++sequence.current,
      abort = new AbortController()
    active.current = abort
    try {
      if (mode === "search") {
        const value = await semanticSearch(api, question, abort.signal)
        if (sequence.current === id) setResults(value.results)
      } else {
        const value = await askDocuments(api, question, abort.signal)
        if (sequence.current === id) setAnswer(value)
      }
    } catch (reason) {
      if (sequence.current === id) {
        if (reason instanceof ApiError && reason.status === 401)
          cache.setQueryData(userKey, null)
        setError(aiError(reason))
      }
    } finally {
      if (sequence.current === id) {
        busy.current = false
        setPending(false)
        active.current = null
      }
    }
  }
  return (
    <div className="mx-auto max-w-3xl min-w-0 space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">AI Search</h1>
        <p className="text-sm text-muted-foreground">
          Find relevant text or ask a standalone question about your prepared
          documents.
        </p>
      </header>
      <div
        role="group"
        aria-label="Search mode"
        className="flex flex-wrap gap-2"
      >
        {(["search", "ask"] as const).map((value) => (
          <Button
            key={value}
            variant={mode === value ? "default" : "outline"}
            aria-pressed={mode === value}
            onClick={() => {
              reset()
              setMode(value)
              form.reset()
            }}
          >
            {value === "search" ? "Semantic search" : "Ask documents"}
          </Button>
        ))}
      </div>
      <Card className="gap-4 p-4 sm:p-6">
        <form
          onSubmit={(event) => void form.handleSubmit(submit)(event)}
          className="space-y-3"
        >
          <Label htmlFor="ai-question">
            {mode === "search" ? "Search query" : "Question"}
          </Label>
          <Textarea
            id="ai-question"
            placeholder={
              mode === "search"
                ? "Find information in your documents"
                : "What do your documents say about…?"
            }
            maxLength={4000}
            rows={3}
            aria-invalid={!!form.formState.errors.question}
            aria-describedby="question-help question-error"
            disabled={pending}
            {...form.register("question")}
          />
          <p id="question-help" className="text-xs text-muted-foreground">
            Up to 4000 characters. Each submission is independent; previous
            answers are not used as context.
          </p>
          <p
            id="question-error"
            role={form.formState.errors.question ? "alert" : undefined}
            className="text-sm text-destructive"
          >
            {form.formState.errors.question?.message}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending
                ? "Submitting…"
                : mode === "search"
                  ? "Search documents"
                  : "Ask documents"}
            </Button>
            {pending && (
              <Button type="button" variant="outline" onClick={reset}>
                Cancel request
              </Button>
            )}
          </div>
        </form>
      </Card>
      <p className="text-sm text-muted-foreground">
        Only prepared, active current versions can participate.{" "}
        <Link href="/documents" className="text-primary underline">
          Check document preparation
        </Link>
        .
      </p>
      <div aria-live="polite" aria-busy={pending} className="min-w-0 space-y-4">
        {pending && (
          <div
            role="status"
            aria-label={
              mode === "search"
                ? "Searching documents"
                : "Generating grounded answer"
            }
          >
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="mt-3 h-24 w-full" />
          </div>
        )}
        {error && (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        )}
        {results && (
          <>
            <h2 className="text-xl font-medium">
              {results.length} {results.length === 1 ? "result" : "results"}
            </h2>
            {results.length ? (
              results.map((result) => (
                <SemanticResultCard key={result.chunkId} result={result} />
              ))
            ) : (
              <p>
                No relevant text was found in your available documents. Try a
                different query or check document preparation.
              </p>
            )}
          </>
        )}
        {answer?.outcome === "insufficient_evidence" && (
          <Card className="gap-3 p-4">
            <h2 className="text-lg font-medium">Insufficient evidence</h2>
            <p className="text-sm">
              {answer.reason === "evidence_changed"
                ? "A source changed or became unavailable. Submit your question again to check current evidence."
                : "Qyvra couldn’t find enough relevant information in your available documents to answer this question."}
            </p>
          </Card>
        )}
        {answer?.outcome === "answered" && (
          <Card className="gap-4 p-4 sm:p-6">
            <h2 className="text-xl font-medium">Grounded answer</h2>
            <AnswerText
              text={answer.answer}
              citations={answer.citations}
              open={(citation, trigger) => setSelected({ citation, trigger })}
            />
            <h3 className="font-medium">Sources</h3>
            <ul className="space-y-2">
              {answer.citations.map((c) => (
                <li key={c.citationId}>
                  <Button
                    variant="outline"
                    className="h-auto max-w-full justify-start text-left whitespace-normal"
                    onClick={(event) =>
                      setSelected({ citation: c, trigger: event.currentTarget })
                    }
                  >
                    {c.citationId} · {c.title} · Version {c.versionNumber}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      {selected && (
        <CitationSheet
          key={selected.citation.chunkId}
          citation={selected.citation}
          trigger={selected.trigger}
          owner={owner}
          close={() => setSelected(null)}
        />
      )}
    </div>
  )
}
