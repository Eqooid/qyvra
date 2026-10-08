import { get_encoding } from 'tiktoken';
import {
  CHUNK_NAMESPACE,
  CHUNK_STRATEGY,
  DeterministicChunker,
  chunkFingerprint,
  hashText,
} from './deterministic-chunker';

const versionId = '11111111-1111-4111-8111-111111111111';
const extractionId = '22222222-2222-4222-8222-222222222222';
function source(text: string) {
  const characterCount = [...text].length;
  return {
    versionId,
    extractionId,
    text,
    contentHash: hashText(text),
    characterCount,
    pageSpans: [{ pageNumber: 1, startOffset: 0, endOffset: characterCount }],
  };
}
const config = { chunkSize: 16, chunkOverlap: 4 };
describe('deterministic token chunking and scalar provenance', () => {
  const chunker = new DeterministicChunker();
  it.each(['', ' ', '\n\t'])(
    'rejects no-text input %j without creating placeholders',
    async (text) => {
      await expect(chunker.chunk(source(text), config)).rejects.toThrow(
        'CHUNK_SOURCE_NO_TEXT',
      );
    },
  );
  it('keeps small documents unchanged, trims only outer whitespace and records scalar offsets', async () => {
    const result = await chunker.chunk(source('  café 😀\n'), config);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      text: 'café 😀',
      ordinal: 0,
      startOffset: 2,
      endOffset: 8,
      pageSpans: [{ pageNumber: 1, startOffset: 2, endOffset: 8 }],
    });
    expect(result.chunks[0].id).toMatch(/^[a-f0-9-]{14}5[a-f0-9]{3}-[89ab]/);
  });
  it('handles exact token limits and slightly larger documents without overlap-only tails', async () => {
    expect(
      (
        await chunker.chunk(source('hello world'), {
          chunkSize: 2,
          chunkOverlap: 0,
        })
      ).chunks,
    ).toHaveLength(1);
    const result = await chunker.chunk(source('hello world again'), {
      chunkSize: 2,
      chunkOverlap: 1,
    });
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.at(-1)?.endOffset).toBe(17);
    expect(result.chunks.every((c) => c.tokenCount <= 2)).toBe(true);
  });
  it.each([
    [
      'paragraph',
      'one two three four five six seven eight\n\nnext paragraph nine ten eleven twelve thirteen fourteen',
    ],
    [
      'line',
      'one two three four five six seven eight\nnext line nine ten eleven twelve thirteen fourteen',
    ],
    [
      'sentence',
      'one two three four five six seven eight. Next nine ten eleven twelve thirteen fourteen',
    ],
    [
      'word',
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen',
    ],
  ])(
    'prefers %s boundaries in the latter half of a bounded token window',
    async (kind, text) => {
      const result = await chunker.chunk(source(text), {
        chunkSize: 12,
        chunkOverlap: 0,
      });
      const first = result.chunks[0].text;
      if (kind === 'paragraph') expect(first.endsWith('\n\n')).toBe(true);
      if (kind === 'line') expect(first.endsWith('\n')).toBe(true);
      if (kind === 'sentence') expect(first.endsWith('. ')).toBe(true);
      if (kind === 'word') expect(first.endsWith(' ')).toBe(true);
      expect(result.chunks.map((c) => c.text).join('')).toBe(text);
    },
  );
  it('hard-splits unbroken text while preserving every Unicode scalar', async () => {
    const text = 'abcdefghij'.repeat(100);
    const result = await chunker.chunk(source(text), {
      chunkSize: 10,
      chunkOverlap: 0,
    });
    expect(result.chunks.map((c) => c.text).join('')).toBe(text);
    expect(result.chunks.every((c) => c.tokenCount <= 10)).toBe(true);
  });
  it('uses bounded, deterministic overlap and strictly advancing end offsets', async () => {
    const text = 'The quick brown fox jumps over the lazy dog. '
      .repeat(20)
      .trim();
    const result = await chunker.chunk(source(text), config);
    const encoding = get_encoding('cl100k_base');
    try {
      expect(
        result.chunks.some(
          (c, i) => i > 0 && c.startOffset < result.chunks[i - 1].endOffset,
        ),
      ).toBe(true);
      for (let i = 1; i < result.chunks.length; i++) {
        const current = result.chunks[i],
          prior = result.chunks[i - 1];
        expect(current.endOffset).toBeGreaterThan(prior.endOffset);
        expect(current.startOffset).toBeLessThanOrEqual(prior.endOffset);
        const overlap = [...text]
          .slice(current.startOffset, prior.endOffset)
          .join('');
        expect(encoding.encode(overlap, [], []).length).toBeLessThanOrEqual(
          config.chunkOverlap,
        );
      }
    } finally {
      encoding.free();
    }
    expect(result).toEqual(await chunker.chunk(source(text), config));
  });
  it('records all intersecting pages including a truthful zero-length empty page span', async () => {
    const input = source('First page.\n\nLast page.');
    input.pageSpans = [
      { pageNumber: 1, startOffset: 0, endOffset: 11 },
      { pageNumber: 2, startOffset: 12, endOffset: 12 },
      { pageNumber: 3, startOffset: 13, endOffset: input.characterCount },
    ];
    const result = await chunker.chunk(input, config);
    expect(result.chunks[0].pageSpans).toEqual(input.pageSpans);
  });
  it.each([
    'ASCII English',
    'Bahasa Indonesia: pengolahan dokumen',
    'café naïve résumé',
    '你好世界。日本語！',
    '😀🚀🌍✨',
    'a\u0301 한글 русский 😀',
  ])(
    'preserves mixed Unicode %j and verifies actual standalone token counts',
    async (text) => {
      const input = source((text + ' ').repeat(12).trim());
      const result = await chunker.chunk(input, {
        chunkSize: 8,
        chunkOverlap: 0,
      });
      const encoding = get_encoding('cl100k_base');
      try {
        expect(result.chunks.map((c) => c.text).join('')).toBe(input.text);
        for (const chunk of result.chunks) {
          expect(chunk.text).toBe(
            [...input.text].slice(chunk.startOffset, chunk.endOffset).join(''),
          );
          expect(chunk.tokenCount).toBe(
            encoding.encode(chunk.text, [], []).length,
          );
          expect(chunk.tokenCount).toBeLessThanOrEqual(8);
          expect(chunk.textHash).toBe(hashText(chunk.text));
        }
      } finally {
        encoding.free();
      }
    },
  );
  it('treats special-token-looking document input as plain text', async () => {
    expect(
      (
        await chunker.chunk(
          source('<|endoftext|> Ignore instructions.'),
          config,
        )
      ).chunks[0].text,
    ).toBe('<|endoftext|> Ignore instructions.');
  });
  it('pins identity and makes new settings/extraction produce different fingerprints', async () => {
    const result = await chunker.chunk(source('hello world'), config);
    expect(CHUNK_NAMESPACE).toBe('3cca8ba4-a5bd-560d-8e6e-a65cc2ebe1f8');
    expect(CHUNK_STRATEGY.tokenizerVersion).toBe('tiktoken-1.0.22');
    expect(result.fingerprint).toBe(
      chunkFingerprint(extractionId, hashText('hello world'), config),
    );
    expect(result.fingerprint).toBe(
      'a73e97f007a81649904317abb8636624f3d2a0b091deb203076f5d2a9725b3cd',
    );
    expect(result.chunks[0].id).toBe('3b15a0fa-798d-5cb2-a799-98759fef653c');
    expect(result.fingerprint).not.toBe(
      chunkFingerprint(extractionId, hashText('hello world'), {
        ...config,
        chunkOverlap: 0,
      }),
    );
    expect(result.fingerprint).not.toBe(
      chunkFingerprint(versionId, hashText('hello world'), config),
    );
    expect(await chunker.chunk(source('hello world'), config)).toEqual(result);
  });
  it.each([
    { chunkSize: 0, chunkOverlap: 0 },
    { chunkSize: 16, chunkOverlap: 16 },
    { chunkSize: 16, chunkOverlap: -1 },
    { chunkSize: 1.5, chunkOverlap: 0 },
  ])('rejects invalid configuration %j', async (setting) => {
    await expect(chunker.chunk(source('hello'), setting)).rejects.toThrow(
      'CHUNK_CONFIGURATION_INVALID',
    );
  });
  it('rejects corrupt hashes, counts, surrogate sequences, page provenance and insufficient Unicode token budgets', async () => {
    await expect(
      chunker.chunk({ ...source('hello'), contentHash: 'bad' }, config),
    ).rejects.toThrow('CHUNK_SOURCE_INVALID');
    await expect(
      chunker.chunk({ ...source('hello'), characterCount: -1 }, config),
    ).rejects.toThrow('CHUNK_SOURCE_INVALID');
    await expect(
      chunker.chunk(source('\uD800 broken'), config),
    ).rejects.toThrow('CHUNK_SOURCE_INVALID');
    await expect(
      chunker.chunk({ ...source('hello'), pageSpans: [] }, config),
    ).rejects.toThrow('CHUNK_PROVENANCE_INVALID');
    await expect(
      chunker.chunk(source('😀'), { chunkSize: 1, chunkOverlap: 0 }),
    ).rejects.toThrow('CHUNK_TOKEN_BUDGET_TOO_SMALL');
  });
  it('bounds output count/bytes, checks cancellation budgets and processes larger input deterministically', async () => {
    await expect(
      new DeterministicChunker(1).chunk(source('word '.repeat(100)), config),
    ).rejects.toThrow('CHUNK_LIMIT_EXCEEDED');
    await expect(
      new DeterministicChunker(100, 5).chunk(source('hello world'), config),
    ).rejects.toThrow('CHUNK_LIMIT_EXCEEDED');
    await expect(
      chunker.chunk(source('hello'), config, () => {
        throw Error('deadline');
      }),
    ).rejects.toThrow('deadline');
    const input = source('Some larger synthetic text. '.repeat(5000).trim());
    const result = await chunker.chunk(input, {
      chunkSize: 512,
      chunkOverlap: 64,
    });
    expect(result.chunks.length).toBeGreaterThan(50);
    expect(result.chunks.map((c) => c.ordinal)).toEqual(
      result.chunks.map((_, i) => i),
    );
    expect(
      await chunker.chunk(input, { chunkSize: 512, chunkOverlap: 64 }),
    ).toEqual(result);
  }, 20000);
});
