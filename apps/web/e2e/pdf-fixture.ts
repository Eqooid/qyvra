// Small generated PDFs with explicit Unicode mappings; no runtime dependency.
export function textPdf(pages: string[]): Buffer {
  const characters = [...new Set(Array.from(pages.join("")))]
  const codes = new Map(
    characters.map((character, index) => [character, index + 1])
  )
  const hex = (value: number) => value.toString(16).padStart(4, "0")
  const unicode = (value: string) =>
    Array.from({ length: value.length }, (_, i) =>
      hex(value.charCodeAt(i))
    ).join("")
  const mappings = characters.map(
    (character) => `<${hex(codes.get(character)!)}> <${unicode(character)}>`
  )
  const groups: string[] = []
  for (let i = 0; i < mappings.length; i += 100) {
    const group = mappings.slice(i, i + 100)
    groups.push(`${group.length} beginbfchar\n${group.join("\n")}\nendbfchar`)
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /QyvraUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${groups.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`
  const stream = (value: string) =>
    `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${8 + i * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /QyvraFixture /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /QyvraFixture /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 500 >>",
    "<< /Type /FontDescriptor /FontName /QyvraFixture /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>",
    stream(cmap),
    "<< >>",
  ]
  for (const page of pages) {
    objects.push(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents " +
        (objects.length + 2) +
        " 0 R >>"
    )
    const lines = page.split("\n").map(
      (line) =>
        `<${Array.from(line)
          .map((c) => hex(codes.get(c)!))
          .join("")}> Tj 0 -16 Td`
    )
    objects.push(stream(`BT /F1 12 Tf 40 740 Td ${lines.join("\n")} ET`))
  }
  let result = "%PDF-1.7\n"
  const offsets: number[] = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result))
    result += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(result)
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join("")}`
  return Buffer.from(
    result +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  )
}
