import { createHash, randomUUID } from 'node:crypto';
import {
  lexicalBatches,
  lexicalRecords,
  lexicalManifest,
} from './lexical-projection';

const projection = {
  userId: randomUUID(),
  documentId: randomUUID(),
  documentVersionId: randomUUID(),
  id: randomUUID(),
  revision: 1,
  indexGenerationId: randomUUID(),
  metadataHash: 'a'.repeat(64),
};
const document = {
  title: 'Fixture',
  description: null,
  issuer: null,
  referenceNumber: null,
  categoryId: null,
  documentDate: null,
  expirationDate: null,
  documentType: 'OTHER' as const,
  status: 'UPLOADED' as const,
  createdAt: new Date('2026-10-14T00:00:00Z'),
  updatedAt: new Date('2026-10-14T00:00:00Z'),
};
const version = {
  originalFilename: 'fixture.pdf',
  mimeType: 'application/pdf',
  fileSize: 12,
};
function content(
  text: string,
  pageSpans = [
    { pageNumber: 1, startOffset: 0, endOffset: Array.from(text).length },
  ],
) {
  return {
    text,
    pageCount: pageSpans.length,
    characterCount: Array.from(text).length,
    pageSpans,
    contentHash: createHash('sha256').update(text).digest('hex'),
  };
}
describe('deterministic lexical projection', () => {
  it('segments Unicode scalars independently of tokenizers and preserves exact offsets', () => {
    const text = '\u{1f600}'.repeat(8193);
    const records = lexicalRecords(
      projection,
      document,
      version,
      [],
      content(text),
    );
    expect(records.slice(1)).toMatchObject([
      { pageNumber: 1, segment: 0, startOffset: 0, endOffset: 8192 },
      {
        pageNumber: 1,
        segment: 1,
        startOffset: 8192,
        endOffset: 8193,
        text: '\u{1f600}',
      },
    ]);
    expect(lexicalManifest(records)).toEqual(
      lexicalManifest(
        lexicalRecords(projection, document, version, [], content(text)),
      ),
    );
    expect(lexicalManifest(records).expectedRecordIds).toEqual([
      `${projection.id}:metadata`,
      `${projection.id}:page:1:0`,
      `${projection.id}:page:1:1`,
    ]);
  });
  it('preserves empty page boundaries without inventing searchable page text', () => {
    const records = lexicalRecords(
      projection,
      document,
      version,
      [],
      content('First\n\n\n\nThird', [
        { pageNumber: 1, startOffset: 0, endOffset: 5 },
        { pageNumber: 2, startOffset: 7, endOffset: 7 },
        { pageNumber: 3, startOffset: 9, endOffset: 14 },
      ]),
    );
    expect(records.slice(1)).toMatchObject([
      { pageNumber: 1, text: 'First' },
      { pageNumber: 3, text: 'Third' },
    ]);
  });
  it('normalizes tag ordering in deterministic metadata', () => {
    const a = randomUUID(),
      b = randomUUID();
    expect(lexicalRecords(projection, document, version, [a, b])).toEqual(
      lexicalRecords(projection, document, version, [b, a]),
    );
  });
  it.each(['checksum', 'span', 'count', 'empty'])(
    'rejects invalid canonical %s',
    (mode) => {
      const artifact = content('Text');
      if (mode === 'checksum') artifact.contentHash = 'b'.repeat(64);
      if (mode === 'span') artifact.pageSpans[0].startOffset = 1;
      if (mode === 'count') artifact.characterCount = 9;
      if (mode === 'empty') Object.assign(artifact, content(''));
      expect(() =>
        lexicalRecords(projection, document, version, [], artifact),
      ).toThrow('SEARCH_CONTRACT_INVALID');
    },
  );
  it('bounds Unicode wire bytes as well as the number of records', () => {
    const records = lexicalRecords(
      projection,
      document,
      version,
      [],
      content('\u{1f600}'.repeat(16385)),
    );
    const target = {
      id: projection.indexGenerationId,
      generation: 1,
      fingerprint: 'a'.repeat(64),
    };
    const batches = lexicalBatches(records, target, 'qyvra-search', 100, 40000);
    expect(batches.flat()).toEqual(records);
    expect(batches).toHaveLength(2);
    expect(() =>
      lexicalBatches(records, target, 'qyvra-search', 100, 1000),
    ).toThrow('SEARCH_CAPACITY');
  });
});
