import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { newQuoteRef, only } from './quote.service.js';

describe('Customer Service quote', () => {
  it('takes the one value the cards leave, the given one, or asks', () => {
    expect(only('mode', ['ROAD', 'ROAD'], undefined)).toBe('ROAD');
    expect(only('mode', [], undefined)).toBeNull();
    expect(only('mode', ['ROAD', 'SEA'], 'SEA')).toBe('SEA');
    expect(only('mode', ['ROAD'], 'SEA')).toBeNull();
    let refused: unknown;
    try {
      only('currency', ['USD', 'AED', 'USD'], undefined);
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(422);
    expect((refused as HttpException).getResponse()).toMatchObject({
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
