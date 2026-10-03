import { describe, expect, it } from 'vitest';
import ar from '../../messages/ar.json' with { type: 'json' };
import en from '../../messages/en.json' with { type: 'json' };

function keys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('translations', () => {
  it('ar and en define exactly the same keys', () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });

  it('has no empty strings', () => {
    for (const messages of [ar, en]) {
      const empty = keys(messages).filter((path) => {
        const leaf = path.split('.').reduce<unknown>((node, key) => {
          return (node as Record<string, unknown>)[key];
        }, messages);
        return typeof leaf === 'string' && leaf.trim() === '';
      });
      expect(empty).toEqual([]);
    }
  });
});
