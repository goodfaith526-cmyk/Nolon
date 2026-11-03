import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { estimateOf, imageTypeOf } from './estimates.js';

describe('imageTypeOf (plan 09 section 12)', () => {
  it('reads JPEG, PNG and WebP from the bytes only', () => {
    expect(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg');
    expect(imageTypeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'image/png',
    );
    expect(imageTypeOf(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'))).toBe(
      'image/webp',
    );
  });

  it('refuses anything else, a PDF named .jpg included', () => {
    expect(imageTypeOf(Buffer.from('%PDF-1.7\n'))).toBeNull();
    expect(imageTypeOf(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE', 'latin1'))).toBeNull();
    expect(imageTypeOf(Buffer.alloc(0))).toBeNull();
    expect(imageTypeOf(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

describe('estimateOf', () => {
  const base = {
    estimateVersion: 2,
    estimateAmount: new Prisma.Decimal('120.5000'),
    estimateCurrency: 'USD',
    estimateNoteAr: 'يشمل التغليف',
    estimateNoteEn: null,
    estimateValidUntil: new Date('2026-11-10T00:00:00.000Z'),
  };

  it('gives the version, amount, currency, note in both languages and validity', () => {
    expect(estimateOf(base)).toEqual({
      version: 2,
      amount: '120.5',
      currency: 'USD',
      note: { ar: 'يشمل التغليف', en: 'يشمل التغليف' },
      validUntil: '2026-11-10T00:00:00.000Z',
    });
  });

  it('is none before staff estimate', () => {
    expect(
      estimateOf({
        ...base,
        estimateVersion: 0,
        estimateAmount: null,
        estimateCurrency: null,
        estimateValidUntil: null,
      }),
    ).toBeNull();
  });
});
