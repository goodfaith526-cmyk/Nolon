'use client';

import type { TripKind } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';

/** datetime-local value (local time, no zone) to an ISO timestamp with offset. */
export function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Formats an API timestamp in the page language; '—' when missing. */
export function useDateTime(): (iso: string | null) => string {
  const locale = useLocale();
  const format = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );
  return (iso) => (iso ? format.format(new Date(iso)) : '—');
}

/** "Own vehicle" / "External carrier". */
export function TripKindLabel({ kind }: { kind: TripKind }) {
  const te = useTranslations('Enums');
  return <span className={`badge badge-kind-${kind}`}>{te(`tripKind_${kind}`)}</span>;
}
