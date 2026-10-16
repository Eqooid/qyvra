/** T08 offsets are Unicode scalar indices, not JavaScript UTF-16 indices. */
export function SafeHighlight({
  snippet,
  ranges,
}: {
  snippet: string
  ranges?: { start: number; end: number }[]
}) {
  const chars = Array.from(snippet)
  let end = 0
  const valid =
    ranges &&
    ranges.length <= 32 &&
    ranges.every((r) => {
      const ok =
        Number.isInteger(r.start) &&
        Number.isInteger(r.end) &&
        r.start >= end &&
        r.end > r.start &&
        r.end <= chars.length
      end = r.end
      return ok
    })
  if (!valid) return <>{snippet}</>
  let cursor = 0
  const parts: React.ReactNode[] = []
  ranges.forEach((r, i) => {
    parts.push(chars.slice(cursor, r.start).join(""))
    parts.push(
      <mark
        key={i}
        className="rounded-sm bg-amber-200 text-amber-950 dark:bg-amber-300 dark:text-amber-950"
      >
        {chars.slice(r.start, r.end).join("")}
      </mark>
    )
    cursor = r.end
  })
  parts.push(chars.slice(cursor).join(""))
  return <>{parts}</>
}
