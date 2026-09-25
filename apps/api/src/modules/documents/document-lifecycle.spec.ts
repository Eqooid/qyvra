import {
  DocumentNotFound,
  DocumentStateConflict,
  transitionDocument,
} from './document-lifecycle';
import { documentCursor, parseDocumentCursor } from './document-pagination';
import { isCalendarDate } from './documents.dto';

describe('document lifecycle and pagination rules', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const active = { status: 'UPLOADED', isArchived: false, deletedAt: null };
  it('archives, soft deletes and restores without claiming READY processing', () => {
    expect(transitionDocument(active, 'archive', now)).toEqual({
      status: 'ARCHIVED',
      isArchived: true,
    });
    expect(transitionDocument(active, 'delete', now)).toEqual({
      deletedAt: now,
    });
    expect(
      transitionDocument(
        { status: 'ARCHIVED', isArchived: true, deletedAt: null },
        'delete',
        now,
      ),
    ).toEqual({ deletedAt: now });
    for (const row of [
      { ...active, deletedAt: now },
      { status: 'ARCHIVED', isArchived: true, deletedAt: null },
      { status: 'ARCHIVED', isArchived: true, deletedAt: now },
    ])
      expect(transitionDocument(row, 'restore', now)).toEqual({
        status: 'UPLOADED',
        isArchived: false,
        deletedAt: null,
      });
  });
  it('preserves timestamps for repeated operations', () => {
    expect(transitionDocument(active, 'restore', now)).toEqual({});
    expect(
      transitionDocument({ ...active, deletedAt: now }, 'delete', new Date()),
    ).toEqual({});
    expect(
      transitionDocument(
        { ...active, status: 'ARCHIVED', isArchived: true },
        'archive',
        now,
      ),
    ).toEqual({});
    expect(() =>
      transitionDocument({ ...active, deletedAt: now }, 'archive', now),
    ).toThrow(DocumentNotFound);
  });
  it.each(['PROCESSING', 'DELETING', 'UNKNOWN'])(
    'rejects invalid transitions from %s',
    (status) => {
      for (const action of ['archive', 'restore', 'delete'] as const)
        expect(() =>
          transitionDocument({ ...active, status }, action, now),
        ).toThrow(DocumentStateConflict);
    },
  );
  it('validates real dates including leap years', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    for (const value of [
      '2023-02-29',
      '2026-04-31',
      '0000-01-01',
      '2026-01-01T00:00:00Z',
      null,
      123,
    ])
      expect(isCalendarDate(value)).toBe(false);
  });
  it('roundtrips cursor ties and rejects forged shape, dates and sorting', () => {
    const row = { id: '69e064cd-fb20-4e2d-b97f-00a53e251265', createdAt: now };
    const cursor = documentCursor(row, '-createdAt');
    expect(parseDocumentCursor(cursor, '-createdAt')).toEqual({
      id: row.id,
      createdAt: now.toISOString(),
      sort: '-createdAt',
    });
    expect(() => parseDocumentCursor(cursor, 'createdAt')).toThrow();
    for (const value of [
      'invalid',
      'a'.repeat(4097),
      Buffer.from(
        JSON.stringify({
          id: row.id,
          createdAt: '0000-01-01T00:00:00.000Z',
          sort: '-createdAt',
        }),
      ).toString('base64url'),
      Buffer.from(JSON.stringify({ ...row, userId: 'foreign' })).toString(
        'base64url',
      ),
    ])
      expect(() => parseDocumentCursor(value, '-createdAt')).toThrow();
  });
  it('roundtrips typed sort cursors and rejects incompatible or malformed values', () => {
    const row = { id: '69e064cd-fb20-4e2d-b97f-00a53e251265', createdAt: now };
    for (const [sort, value] of [
      ['-updatedAt', now],
      ['title', 'Same title'],
      ['-title', 'Same title'],
      ['-fileSize', 123],
      ['-fileSize', null],
    ] as const) {
      const encoded = documentCursor({ ...row, sortValue: value }, sort);
      expect(parseDocumentCursor(encoded, sort)).toEqual({
        id: row.id,
        sort,
        value: value instanceof Date ? value.toISOString() : value,
      });
      expect(() => parseDocumentCursor(encoded, '-createdAt')).toThrow();
    }
    const forged = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const [sort, value] of [
      ['-updatedAt', 'invalid'],
      ['title', 12],
      ['-title', ''],
      ['-fileSize', -1],
      ['-fileSize', '200'],
    ] as const)
      expect(() =>
        parseDocumentCursor(forged({ id: row.id, sort, value }), sort),
      ).toThrow();
    expect(() =>
      parseDocumentCursor(forged({ id: row.id, sort: 'title' }), 'title'),
    ).toThrow();
    expect(() =>
      parseDocumentCursor(
        forged({ id: row.id, sort: 'bad', value: 'X' }),
        'title',
      ),
    ).toThrow();
    expect(() => parseDocumentCursor('!!!', 'title')).toThrow();
  });
});
