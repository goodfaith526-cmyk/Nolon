import { E164_PATTERN } from '@nolon/shared';

/**
 * Plan 09e: a phone as typed (`+249…`, `00249…`, or local digits) in +E.164 form when it is
 * written internationally, else null. No country is ever guessed for local digits.
 */
export function internationalPhone(typed: string | null | undefined): string | null {
  const compact = typed?.replace(/[\s-]/g, '') ?? '';
  const plus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return E164_PATTERN.test(plus) ? plus : null;
}

/** The same number, read as digits (`+249…`, `00249…` and `249…` agree); a missing one never does. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const digits = (p: string | null | undefined): string => {
    const d = p?.replace(/\D/g, '') ?? '';
    return d.startsWith('00') ? d.slice(2) : d;
  };
  const x = digits(a);
  return x !== '' && x === digits(b);
}
