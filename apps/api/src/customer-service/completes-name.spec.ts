import { describe, expect, it } from 'vitest';
import { completesName } from './customer-identity.service.js';

describe('completesName (owner, 2026-11-07)', () => {
  it('takes the same words with more after them', () => {
    expect(completesName('عبدالرحيم يوسف النعيم', 'عبدالرحيم يوسف النعيم تجربة')).toBe(true);
    expect(completesName('Ali  Omar', ' Ali Omar Hassan ')).toBe(true);
  });
  it('refuses another name, a shorter one, the same one, or a word cut in the middle', () => {
    expect(completesName('Ali Omar', 'Omar Ali Hassan')).toBe(false);
    expect(completesName('Ali Omar Hassan', 'Ali Omar')).toBe(false);
    expect(completesName('Ali Omar', 'Ali Omar')).toBe(false);
    expect(completesName('Ali Om', 'Ali Omar')).toBe(false);
    expect(completesName('', 'Ali')).toBe(false);
  });
});
