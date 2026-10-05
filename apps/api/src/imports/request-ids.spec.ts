import { describe, expect, it } from 'vitest';
import { importRecordId, importRecordIds } from './request-ids.js';

const REQUEST = '0b5e3a1e-7a5c-4c37-9f7c-1a2b3c4d5e6f';

describe('importRecordId', () => {
  it('derives the same UUID for the same request and index', () => {
    expect(importRecordId(REQUEST, 3)).toBe(importRecordId(REQUEST, 3));
    expect(importRecordId(REQUEST, 3)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('differs by index and by request', () => {
    const ids = importRecordIds(REQUEST, 500);
    expect(new Set(ids).size).toBe(500);
    expect(importRecordId(REQUEST, 0)).not.toBe(
      importRecordId('1b5e3a1e-7a5c-4c37-9f7c-1a2b3c4d5e6f', 0),
    );
  });
});
