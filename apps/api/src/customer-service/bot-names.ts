import type { CsName } from '@nolon/shared';

/**
 * A name as people write it, for comparing only: trimmed, inner spaces collapsed, lower case,
 * Arabic letter forms folded (أ إ آ ٱ to ا, ة to ه, ى to ي) and tatweel and diacritics dropped.
 */
export function fold(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export interface NamedPlace {
  id: string;
  kind: string;
  nameAr: string;
  nameEn: string;
  cityId: string | null;
  aliases: readonly string[];
}

function names(given: CsName): Set<string> {
  return new Set([fold(given.ar), fold(given.en)].filter((n) => n !== ''));
}

/**
 * The one place a name means: its Arabic or English name, or one of its other names. When a city
 * and places of that city share the name, the city. Anything else (no match, or two unrelated
 * places) is null: staff choose.
 */
export function matchPlace(given: CsName, places: readonly NamedPlace[]): string | null {
  const wanted = names(given);
  const hits = places.filter((p) =>
    [p.nameAr, p.nameEn, ...p.aliases].some((n) => wanted.has(fold(n))),
  );
  if (hits.length === 1) return hits[0]?.id ?? null;
  const cities = hits.filter((p) => p.kind === 'CITY');
  const city = cities.length === 1 ? cities[0] : undefined;
  if (city && hits.every((p) => p.id === city.id || p.cityId === city.id)) return city.id;
  return null;
}

export interface NamedCategory {
  code: string;
  nameAr: string;
  nameEn: string;
}

/** The one shipment type a name means: its code or its Arabic or English name; else null. */
export function matchCategory(given: CsName, categories: readonly NamedCategory[]): string | null {
  const wanted = names(given);
  const hits = categories.filter((c) =>
    [c.code, c.nameAr, c.nameEn].some((n) => wanted.has(fold(n))),
  );
  return hits.length === 1 ? (hits[0]?.code ?? null) : null;
}
