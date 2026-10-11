import { describe, expect, it } from 'vitest';
import { idsIn } from './reference-names.js';

describe('idsIn', () => {
  it('finds every id in nested values, lower-cased, and nothing else', () => {
    const a = '0f8c2a7e-1b2c-4d3e-8f90-123456789abc';
    const b = 'A1B2C3D4-0000-4000-8000-00000000000F';
    const found = idsIn({
      customerId: a,
      lines: [{ rateCardId: b, description: `see ${a}` }, { quantity: '2' }],
      terms: null,
      count: 3,
    });
    expect([...found]).toEqual([a, b.toLowerCase()]);
    expect([...idsIn(undefined)]).toEqual([]);
  });
});
