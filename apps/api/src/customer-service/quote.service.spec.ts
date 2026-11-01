import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { newQuoteRef, only, volumeOf } from './quote.service.js';

function refusal(run: () => unknown): HttpException {
  let refused: unknown;
  try {
    run();
  } catch (e) {
    refused = e;
  }
  expect(refused).toBeInstanceOf(HttpException);
  return refused as HttpException;
}

describe('Customer Service quote', () => {
  it('takes the one value the cards leave, the given one, or asks', () => {
    expect(only('mode', ['ROAD', 'ROAD'], undefined)).toBe('ROAD');
    expect(only('mode', [], undefined)).toBeNull();
    expect(only('mode', ['ROAD', 'SEA'], 'SEA')).toBe('SEA');
    expect(only('mode', ['ROAD'], 'SEA')).toBeNull();
    const refused = refusal(() => only('currency', ['USD', 'AED', 'USD'], undefined));
    expect(refused.getStatus()).toBe(422);
    expect(refused.getResponse()).toMatchObject({
      code: 'QUOTE_AMBIGUOUS',
      choices: { field: 'currency', values: ['AED', 'USD'] },
    });
  });

  it('makes random references', () => {
    const a = newQuoteRef();
    expect(a).toMatch(/^q_[A-Za-z0-9_-]{32}$/);
    expect(newQuoteRef()).not.toBe(a);
  });
});

describe('volumeOf (a PER_CBM category is priced by the CBM of the pieces, owner 2026-11-01)', () => {
  const dims = { lengthCm: '120', widthCm: '100', heightCm: '150' };

  it('computes the CBM of the pieces as bookings do, 4 places half up', () => {
    // Three standard pallets 120 × 100 × 150 cm = 1.8 m³ each.
    const volume = volumeOf({ quantity: '3', ...dims });
    expect(volume.pieces).toBe(3);
    expect(volume.cbm.toFixed()).toBe('5.4');
    expect(volume.dimensions.lengthCm.toFixed()).toBe('120');
    const cube = { quantity: '1', lengthCm: '33.3', widthCm: '33.3', heightCm: '33.3' };
    expect(volumeOf(cube).cbm.toFixed()).toBe('0.0369');
    const small = { quantity: '3', lengthCm: '10.5', widthCm: '20.25', heightCm: '30' };
    expect(volumeOf(small).cbm.toFixed()).toBe('0.0191');
    // 2.0 pieces are 2 pieces.
    expect(volumeOf({ quantity: '2.0', ...dims }).pieces).toBe(2);
  });

  it('asks for what is missing with 422 DIMENSIONS_REQUIRED, naming the fields', () => {
    const none = refusal(() => volumeOf({}));
    expect(none.getStatus()).toBe(422);
    expect(none.getResponse()).toMatchObject({
      code: 'DIMENSIONS_REQUIRED',
      fields: ['quantity', 'lengthCm', 'widthCm', 'heightCm'],
    });
    expect(refusal(() => volumeOf({ quantity: '3' })).getResponse()).toMatchObject({
      code: 'DIMENSIONS_REQUIRED',
      fields: ['lengthCm', 'widthCm', 'heightCm'],
    });
    expect(
      refusal(() => volumeOf({ quantity: '3', lengthCm: '120', widthCm: '100' })).getResponse(),
    ).toMatchObject({ code: 'DIMENSIONS_REQUIRED', fields: ['heightCm'] });
    expect(refusal(() => volumeOf(dims)).getResponse()).toMatchObject({
      code: 'DIMENSIONS_REQUIRED',
      fields: ['quantity'],
    });
  });

  it('refuses a volume that would overflow Decimal(18, 4) storage', () => {
    const huge = { quantity: '1', lengthCm: '10000000', widthCm: '10000000', heightCm: '10000000' };
    expect(refusal(() => volumeOf(huge)).getResponse()).toMatchObject({
      code: 'DIMENSIONS_REQUIRED',
      fields: ['lengthCm', 'widthCm', 'heightCm', 'quantity'],
    });
  });

  it('takes only a whole number of pieces, and a volume that does not round to nothing', () => {
    for (const quantity of ['1.5', '0', '100001']) {
      expect(refusal(() => volumeOf({ quantity, ...dims })).getResponse()).toMatchObject({
        code: 'DIMENSIONS_REQUIRED',
        fields: ['quantity'],
      });
    }
    // 1 × 1 × 1 cm = 0.000001 m³ → 0.0000: surely not centimetres.
    const tiny = { quantity: '1', lengthCm: '1', widthCm: '1', heightCm: '1' };
    expect(refusal(() => volumeOf(tiny)).getResponse()).toMatchObject({
      code: 'DIMENSIONS_REQUIRED',
      fields: ['lengthCm', 'widthCm', 'heightCm'],
    });
  });
});
