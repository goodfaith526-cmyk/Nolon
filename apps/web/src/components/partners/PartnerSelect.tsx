'use client';

import type { Page, PartnerKind, PartnerRefDto, PartnerSummaryDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * What a form sends for a partner it shows (business model PR-3): nothing while the choice is the
 * one the record holds, so the API keeps it (an Outlet Staff user's own outlet included), else the
 * new choice, or null for none.
 */
export function partnerChange(
  held: PartnerRefDto | null,
  value: string,
): string | null | undefined {
  if (value === (held?.id ?? '')) return undefined;
  return value || null;
}

/**
 * Picks an active partner of `kind` of the branch (or branches) a record belongs to, or none. The
 * partner the record holds is offered too, even if since deactivated. The API checks the choice
 * on save; a user who may not list partners is offered only the one held.
 */
export function PartnerSelect({
  kind,
  branchIds,
  held,
  value,
  onChange,
  id,
  name,
  disabled = false,
  'aria-invalid': ariaInvalid,
}: {
  kind: PartnerKind;
  branchIds: readonly string[];
  held: PartnerRefDto | null;
  value: string;
  onChange: (id: string) => void;
  id?: string;
  name?: string;
  disabled?: boolean;
  'aria-invalid'?: true;
}) {
  const t = useTranslations('Partners');
  // The partners read for these branches; another set of branches reads them again.
  const key = `${kind}:${branchIds.join(',')}`;
  const [loaded, setLoaded] = useState<{ key: string; items: PartnerSummaryDto[] } | null>(null);
  const partners = loaded?.key === key ? loaded.items : [];

  useEffect(() => {
    let live = true;
    const [partnerKind, list = ''] = key.split(':');
    const ids = list.split(',').filter(Boolean);
    if (ids.length === 0) return;
    Promise.all(
      ids.map((branchId) =>
        api<Page<PartnerSummaryDto>>(
          `/partners?kind=${partnerKind}&branchId=${branchId}&isActive=true&pageSize=100`,
        ).then((p) => p.items),
      ),
    )
      .then((lists) => {
        if (live) setLoaded({ key, items: lists.flat() });
      })
      .catch(() => {
        if (live) setLoaded({ key, items: [] });
      });
    return () => {
      live = false;
    };
  }, [key]);

  const listed = partners.some((p) => p.id === held?.id);
  return (
    <select
      id={id}
      name={name}
      value={value}
      disabled={disabled}
      aria-invalid={ariaInvalid}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{t('noPartner')}</option>
      {held && !listed && (
        <option value={held.id}>
          {held.name} ({held.number}){held.isActive ? '' : ` · ${t('inactivePartner')}`}
        </option>
      )}
      {partners.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.number})
        </option>
      ))}
    </select>
  );
}

/** A partner as a record's page shows it: name and number, marked when no longer active. */
export function PartnerName({ partner }: { partner: PartnerRefDto | null }) {
  const t = useTranslations('Partners');
  if (!partner) return <>—</>;
  return (
    <>
      {partner.name} <span dir="ltr">({partner.number})</span>
      {partner.isActive ? null : <span className="muted"> · {t('inactivePartner')}</span>}
    </>
  );
}
