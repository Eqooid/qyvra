import {
  canonicalHighlight,
  textSegments,
  validHighlightRanges,
} from './safe-highlights';
import { decodeHighlight } from '../../infrastructure/search/highlight-hints';
import { keywordMatch } from './keyword-search.service';
import type { CanonicalKeywordHit } from './keyword-search.repository';

describe('untrusted highlight hints to canonical scalar evidence', () => {
  it('preserves literal scripts/markers as text and translates emoji and combining UTF-16 offsets', () => {
    const open = '[random:start]',
      close = '[random:end]';
    const text = '\u{1f600} <script>x</script> e\u0301 [literal:start]';
    const hint = decodeHighlight(
      'text',
      `\u{1f600} <script>${open}x${close}</script> ${open}e\u0301${close} [literal:start]`,
      open,
      close,
    )!;
    expect(hint.text).toBe(text);
    const result = canonicalHighlight(text, hint, 10)!;
    expect(result.segments.map((s) => s.text).join('')).toBe(text);
    expect(result.segments.filter((s) => s.matched).map((s) => s.text)).toEqual(
      ['x', 'e\u0301'],
    );
    expect(
      Array.from(text).slice(0, result.ranges[0].start).join('').length,
    ).toBe(text.indexOf('x'));
    expect(result.startOffset).toBe(10);
    expect(result.endOffset).toBe(10 + Array.from(text).length);
  });
  it.each([
    '[s]a',
    'a[e]',
    '[s][s]a[e][e]',
    '[s][e]',
    'x'.repeat(2401),
    '\ud83d[s]\ude00[e]',
  ])('omits malformed or oversized transport fragments', (fragment) => {
    expect(decodeHighlight('text', fragment, '[s]', '[e]')).toBeUndefined();
  });
  it('does not align ambiguous, changed, split-surrogate or unauthorized canonical fragments', () => {
    const hint = {
      field: 'text' as const,
      text: 'same',
      ranges: [{ start: 0, end: 4 }],
    };
    expect(canonicalHighlight('same same', hint)).toBeUndefined();
    expect(canonicalHighlight('different', hint)).toBeUndefined();
    expect(
      canonicalHighlight('\u{1f600}', {
        ...hint,
        text: '\ude00',
        ranges: [{ start: 0, end: 1 }],
      }),
    ).toBeUndefined();
  });
  it('bounds ranges/fragments and rejects overlap, negative, empty and invalid offsets', () => {
    for (const ranges of [
      [{ start: -1, end: 1 }],
      [{ start: 1, end: 1 }],
      [{ start: 0, end: 9 }],
      [
        { start: 0, end: 2 },
        { start: 1, end: 3 },
      ],
      [{ start: NaN, end: 2 }],
      Array(33).fill({ start: 0, end: 1 }),
    ])
      expect(validHighlightRanges('abc', ranges)).toBe(false);
    expect(textSegments('<script>', [{ start: 3, end: 1 }])).toEqual([
      { text: '<script>', matched: false },
    ]);
    const value = '\u{1f600}'.repeat(1000) + 'target';
    const result = canonicalHighlight(value, {
      field: 'text',
      text: 'target',
      ranges: [{ start: 0, end: 6 }],
    })!;
    expect(Array.from(result.snippet)).toHaveLength(400);
    expect(result.segments.some((s) => s.matched && s.text === 'target')).toBe(
      true,
    );
    expect(validHighlightRanges(result.snippet, result.ranges)).toBe(true);
  });
  it('adds stable exact-version page navigation but never invents semantic/chunk identity', () => {
    const source = {
      recordId: 'projection:page:2:0',
      kind: 'page',
      documentId: 'document',
      documentVersionId: 'version',
      projectionId: 'projection',
      excerpt: 'target <script>',
      pageNumber: 2,
      segment: 0,
      extractedTextId: 'artifact',
      startOffset: 100,
    } as CanonicalKeywordHit;
    const match = keywordMatch(source, 'target', 'terms', [
      { field: 'text', text: 'target', ranges: [{ start: 0, end: 6 }] },
    ]);
    expect(match.source).toMatchObject({
      documentVersionId: 'version',
      pageNumber: 2,
      segment: 0,
      sourceId: 'artifact:page:2:segment:0',
    });
    expect(match.source?.href).toBe(
      '/api/v1/documents/document/versions/version/extractions/artifact/pages/2/segments/0',
    );
    expect(match).not.toHaveProperty('chunkId');
    expect(
      keywordMatch(source, 'target', 'terms', [
        { field: 'text', text: 'forged', ranges: [{ start: 0, end: 6 }] },
      ]).ranges,
    ).toEqual([]);
  });
});
