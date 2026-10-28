'use client';

import type { MasterDataDto } from '@nolon/shared';
import { useLocale } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './api';

/** Ports, container types, charge types and currencies, for dropdowns. */
export function useMasterData(): MasterDataDto | null {
  const [data, setData] = useState<MasterDataDto | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<MasterDataDto>('/master-data')
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return data;
}

/** Picks the name in the page language. */
export function useLocalName(): (item: { nameEn: string; nameAr: string }) => string {
  const locale = useLocale();
  return useCallback((item) => (locale === 'ar' ? item.nameAr : item.nameEn), [locale]);
}

/** Looks up a location's name by id. */
/**
 * A location a document may name: a port, city or point. A country (kind COUNTRY) is a pricing
 * scope for rate cards only (business model plan 5.3); NOLON refuses it anywhere else.
 */
export function isPlace(l: { kind: string }): boolean {
  return l.kind !== 'COUNTRY';
}

export function useLocationName(data: MasterDataDto | null): (id: string) => string {
  const name = useLocalName();
  return useCallback(
    (id: string) => {
      const location = data?.locations.find((l) => l.id === id);
      return location ? name(location) : '…';
    },
    [data, name],
  );
}

/** HTTP status of a failed API call, for picking a message. */
export function failureStatus(e: unknown): number {
  return e instanceof ApiError ? e.status : 0;
}
