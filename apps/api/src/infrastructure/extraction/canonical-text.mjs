// Versioned, document-preserving normalization; offsets count Unicode scalars.
export function normalizePage(value) {
  return value
    .toWellFormed()
    .normalize('NFC')
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[\p{Zs}\t]+/gu, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
    .normalize('NFC');
}

export function canonicalContent(pages) {
  let text = '',
    offset = 0;
  const pageSpans = [];
  for (let index = 0; index < pages.length; index++) {
    const page = normalizePage(pages[index]);
    const startOffset = offset;
    text += page;
    for (const ignored of page) {
      void ignored;
      offset++;
    }
    pageSpans.push({ pageNumber: index + 1, startOffset, endOffset: offset });
    if (index < pages.length - 1) {
      text += '\n\n';
      offset += 2;
    }
  }
  return { text, characterCount: offset, pageCount: pages.length, pageSpans };
}
