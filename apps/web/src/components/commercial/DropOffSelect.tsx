'use client';

import type { CsDropOffChoiceDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type ReactNode, type SelectHTMLAttributes, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLocalName } from '@/lib/master-data';

/**
 * Plan 13 section 1: the booking's window (drop-off point), from the active points of `branchId`,
 * each labelled with the outlet that runs it. Renders nothing when the branch has none and none is
 * held, or when the list is refused (no permission to write bookings there). `heldCode` names a
 * held point the list no longer offers.
 */
export function DropOffSelect({
  branchId,
  value,
  onChange,
  heldCode,
  children,
  ...rest
}: {
  branchId: string;
  value: string;
  onChange: (id: string) => void;
  heldCode: string | null;
  /** Shown under the field (its refusal note). */
  children?: ReactNode;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children'>) {
  const t = useTranslations('Bookings');
  const name = useLocalName();
  const [points, setPoints] = useState<{ branchId: string; list: CsDropOffChoiceDto[] } | null>(
    null,
  );
  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    api<CsDropOffChoiceDto[]>(`/bookings/drop-off-points?branchId=${branchId}`)
      .then((list) => {
        if (!cancelled) setPoints({ branchId, list });
      })
      .catch(() => {
        if (!cancelled) setPoints({ branchId, list: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [branchId]);
  const list = points?.branchId === branchId ? points.list : [];
  if (!branchId || (list.length === 0 && !value)) return null;
  return (
    <section className="form-section">
      <header>
        <h2>{t('dropOffTitle')}</h2>
        <p>{t('dropOffHint')}</p>
      </header>
      <div className="form-section-body form-grid">
        <label className="field">
          {t('dropOff')}
          <select {...rest} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">{t('dropOffNone')}</option>
            {value && !list.some((d) => d.id === value) && (
              <option value={value}>{heldCode ?? '—'}</option>
            )}
            {list.map((d) => (
              <option key={d.id} value={d.id}>
                {name(d)} ({d.code}){d.outletName ? ` · ${d.outletName}` : ''}
              </option>
            ))}
          </select>
          {children}
        </label>
      </div>
    </section>
  );
}
