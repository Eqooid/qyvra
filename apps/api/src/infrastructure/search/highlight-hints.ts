import type {
  LexicalHighlightHint,
  HighlightRange,
  SearchHighlightField,
} from './lexical-store';

export const HIGHLIGHT_FIELDS: SearchHighlightField[] = [
  'title',
  'description',
  'issuer',
  'referenceNumber',
  'filename',
  'text',
];
/** Transport markup is discarded. Literal document HTML is never interpreted. */
export function decodeHighlight(
  field: SearchHighlightField,
  value: unknown,
  open: string,
  close: string,
): LexicalHighlightHint | undefined {
  if (typeof value !== 'string' || value.length > 2400) return;
  let cursor = 0,
    text = '',
    active: number | undefined;
  const ranges: HighlightRange[] = [];
  while (cursor < value.length) {
    const start = value.indexOf(open, cursor),
      end = value.indexOf(close, cursor);
    if (start < 0 && end < 0) {
      text += value.slice(cursor);
      break;
    }
    const opening = start >= 0 && (end < 0 || start < end),
      position = opening ? start : end;
    text += value.slice(cursor, position);
    const offset = text.length;
    if (opening) {
      if (active !== undefined) return;
      active = offset;
    } else {
      if (active === undefined || offset <= active || ranges.length >= 32)
        return;
      ranges.push({ start: active, end: offset });
      active = undefined;
    }
    cursor = position + (opening ? open.length : close.length);
  }
  if (active !== undefined || !ranges.length || Array.from(text).length > 800)
    return;
  const boundary = (n: number) =>
    !(
      n > 0 &&
      n < text.length &&
      /[\uD800-\uDBFF]/.test(text[n - 1]) &&
      /[\uDC00-\uDFFF]/.test(text[n])
    );
  if (ranges.some((r) => !boundary(r.start) || !boundary(r.end))) return;
  return {
    field,
    text,
    ranges: ranges.map((r) => ({
      start: Array.from(text.slice(0, r.start)).length,
      end: Array.from(text.slice(0, r.end)).length,
    })),
  };
}
