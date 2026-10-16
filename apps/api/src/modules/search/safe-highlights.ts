import type {
  HighlightRange,
  LexicalHighlightHint,
} from '../../infrastructure/search/lexical-store';

export interface SafeTextSegment {
  text: string;
  matched: boolean;
}
export function validHighlightRanges(
  text: string,
  ranges: readonly HighlightRange[],
): boolean {
  if (!Array.isArray(ranges) || ranges.length > 32) return false;
  const length = Array.from(text).length;
  let previous = 0;
  return ranges.every((range) => {
    if (
      !range ||
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < previous ||
      range.end <= range.start ||
      range.end > length
    )
      return false;
    previous = range.end;
    return true;
  });
}
export function textSegments(
  text: string,
  ranges: readonly HighlightRange[],
): SafeTextSegment[] {
  const scalars = Array.from(text),
    segments: SafeTextSegment[] = [];
  let offset = 0;
  if (!validHighlightRanges(text, ranges)) return [{ text, matched: false }];
  for (const range of ranges) {
    if (range.start > offset)
      segments.push({
        text: scalars.slice(offset, range.start).join(''),
        matched: false,
      });
    segments.push({
      text: scalars.slice(range.start, range.end).join(''),
      matched: true,
    });
    offset = range.end;
  }
  if (offset < scalars.length || !segments.length)
    segments.push({ text: scalars.slice(offset).join(''), matched: false });
  return segments;
}
/** UTF-16 matching is converted to canonical scalar offsets only after unique exact alignment. */
export function canonicalHighlight(
  text: string,
  hint: LexicalHighlightHint | undefined,
  base = 0,
) {
  if (
    !hint ||
    typeof hint.text !== 'string' ||
    !hint.text ||
    hint.text.length > 2400 ||
    !validHighlightRanges(hint.text, hint.ranges) ||
    !hint.ranges.length
  )
    return;
  const units = text.indexOf(hint.text);
  const boundary = (n: number) =>
    !(
      n > 0 &&
      n < text.length &&
      /[\uD800-\uDBFF]/.test(text[n - 1]) &&
      /[\uDC00-\uDFFF]/.test(text[n])
    );
  if (
    units < 0 ||
    text.indexOf(hint.text, units + 1) >= 0 ||
    !boundary(units) ||
    !boundary(units + hint.text.length)
  )
    return;
  const scalars = Array.from(text),
    fragmentOffset = Array.from(text.slice(0, units)).length;
  // Center a bounded excerpt around the first validated mark; no query-token guessing.
  const start = Math.max(
    0,
    Math.min(fragmentOffset + hint.ranges[0].start - 80, scalars.length - 400),
  );
  const snippet = scalars.slice(start, start + 400).join('');
  const ranges = hint.ranges.flatMap((r) => {
    const left = fragmentOffset + r.start - start,
      right = fragmentOffset + r.end - start;
    return left >= 0 && right <= Array.from(snippet).length
      ? [{ start: left, end: right }]
      : [];
  });
  if (!ranges.length) return;
  return {
    snippet,
    startOffset: base + start,
    endOffset: base + start + Array.from(snippet).length,
    ranges,
    segments: textSegments(snippet, ranges),
  };
}
