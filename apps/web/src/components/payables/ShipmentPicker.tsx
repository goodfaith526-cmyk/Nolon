'use client';

import type { ShipmentPickPage, ShipmentSummaryDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { api } from '@/lib/api';

/** A shipment a document line names: its id, and its number to show. */
export interface PickedShipment {
  id: string;
  number: string;
}

const PAGE_SIZE = 10;

/**
 * Picks a shipment for a document of `branchId` (functional review C10), from GET /shipments/pick:
 * shipments visible in that branch and not cancelled, by number or customer. The shipment whose
 * number is exactly the search comes first, however many others match; the others page by number.
 * The API checks the shipment again when the document is saved.
 */
export function ShipmentPicker({
  branchId,
  value,
  onChange,
}: {
  branchId: string;
  value: PickedShipment | null;
  onChange: (shipment: PickedShipment | null) => void;
}) {
  const t = useTranslations('SupplierBills');
  const tc = useTranslations('Common');
  const [q, setQ] = useState('');
  const [result, setResult] = useState<{
    exact: ShipmentSummaryDto | null;
    items: ShipmentSummaryDto[];
    total: number;
    page: number;
  } | null>(null);
  const [failed, setFailed] = useState(false);

  async function search(page: number) {
    setFailed(false);
    try {
      const query = new URLSearchParams({
        branchId,
        q: q.trim(),
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const found = await api<ShipmentPickPage>(`/shipments/pick?${query.toString()}`);
      setResult((before) => ({
        exact: page === 1 ? found.exact : (before?.exact ?? null),
        items: page === 1 ? found.items : [...(before?.items ?? []), ...found.items],
        total: found.total,
        page,
      }));
    } catch {
      setFailed(true);
    }
  }

  if (value) {
    return (
      <div className="row">
        <strong dir="ltr">{value.number}</strong>
        <button type="button" onClick={() => onChange(null)}>
          {tc('change')}
        </button>
      </div>
    );
  }

  const pick = (s: ShipmentSummaryDto) => onChange({ id: s.id, number: s.number });
  const exact = result?.exact ?? null;
  const label = (s: ShipmentSummaryDto) => (
    <>
      <span dir="ltr">{s.number}</span> · {s.customerName}
    </>
  );

  return (
    <div className="stack">
      <div className="row">
        <input
          type="search"
          dir="ltr"
          value={q}
          aria-label={t('shipmentNumber')}
          placeholder={t('shipmentSearch')}
          onChange={(e) => {
            setQ(e.target.value);
            setResult(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void search(1);
            }
          }}
        />
        <button type="button" onClick={() => void search(1)}>
          {tc('search')}
        </button>
      </div>
      {failed && <p className="error">{tc('failed')}</p>}
      {result && (exact || result.items.length > 0) && (
        <ul className="picker">
          {exact && (
            <li>
              <button type="button" onClick={() => pick(exact)}>
                <strong>{t('exactMatch')}</strong> {label(exact)}
              </button>
            </li>
          )}
          {result.items.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => pick(s)}>
                {label(s)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {result && result.items.length < result.total && (
        <div className="actions">
          <button type="button" onClick={() => void search(result.page + 1)}>
            {t('moreShipments')}
          </button>
        </div>
      )}
      {result && !exact && result.items.length === 0 && <p className="muted">{t('noShipments')}</p>}
    </div>
  );
}
