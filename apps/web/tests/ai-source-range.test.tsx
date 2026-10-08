import { render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { AuthProvider } from "@/features/auth/provider"
import { CitationSheet } from "@/features/ai/source-components"
import { citation } from "./ai.fixture"
import { id, json } from "./documents.fixture"

it("resolves a bounded RAG excerpt against its complete canonical chunk without falsely rejecting different full-chunk hashes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () =>
      json({
        data: {
          ...citation,
          excerpt: "Hello world appended",
          excerptEnd: 30,
          excerptHash: "b".repeat(64),
          pageSpans: [
            { pageNumber: 2, startOffset: 10, endOffset: 16 },
            { pageNumber: 3, startOffset: 16, endOffset: 30 },
          ],
        },
      })
    )
  )
  render(
    <AuthProvider>
      <CitationSheet
        citation={citation}
        trigger={document.createElement("button")}
        close={() => {}}
        owner={id}
      />
    </AuthProvider>
  )
  expect(await screen.findByText("Hello world")).toBeInTheDocument()
  expect(screen.queryByText("Hello world appended")).not.toBeInTheDocument()
  expect(screen.getByText("Version 2 · Pages 2, 3")).toBeInTheDocument()
})
