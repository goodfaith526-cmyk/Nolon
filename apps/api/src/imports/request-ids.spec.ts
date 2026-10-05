import { describe, expect, it } from 'vitest';
import {
  importRecordId,
  importRecordIds,
  importRequest,
  importRequestRange,
} from './request-ids.js';

const REQUEST = '0b5e3a1e-7a5c-4c37-9f7c-1a2b3c4d5e6f';
const OTHER_REQUEST = '1b5e3a1e-7a5c-4c37-9f7c-1a2b3c4d5e6f';
const USER = 'a0000000-0000-4000-8000-000000000001';
const FILE = Buffer.from('file one');
const base = importRequest('customers', REQUEST, USER, FILE);

describe('importRecordId', () => {
  it('derives the same UUID for the same request, fingerprint and index', () => {
    const again = importRequest('customers', REQUEST, USER, Buffer.from('file one'));
    expect(importRecordId(again, 3)).toBe(importRecordId(base, 3));
    expect(importRecordId(base, 3)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('differs by index, request, kind, user and file', () => {
    const ids = importRecordIds(base, 500);
    expect(new Set(ids).size).toBe(500);
    const first = importRecordId(base, 0);
    for (const other of [
      importRequest('customers', OTHER_REQUEST, USER, FILE),
      importRequest('rates', REQUEST, USER, FILE),
      importRequest('customers', REQUEST, 'a0000000-0000-4000-8000-000000000002', FILE),
      importRequest('customers', REQUEST, USER, Buffer.from('file two')),
    ]) {
      expect(importRecordId(other, 0)).not.toBe(first);
    }
  });

  it('keeps every id of a requestId, whatever was imported, in its range', () => {
    const { from, to } = importRequestRange(REQUEST);
    const variants = [
      base,
      importRequest('rates', REQUEST, USER, FILE),
      importRequest('customers', REQUEST, USER, Buffer.from('file two')),
    ];
    for (const request of variants) {
      for (const id of importRecordIds(request, 50)) {
        expect(id >= from && id <= to).toBe(true);
      }
    }
    const other = importRecordId(importRequest('customers', OTHER_REQUEST, USER, FILE), 0);
    expect(other >= from && other <= to).toBe(false);
  });
});
