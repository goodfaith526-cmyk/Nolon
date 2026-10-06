'use client';

import type { ConsolidationDto, Page, ShipmentSummaryDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { StatusBadge } from '../StatusBadge';

/** The container's details, for the new container form and the edit form (named inputs). */
export function ConsolidationDetailFields({ value }: { value: ConsolidationDto | null }) {
  const t = useTranslations('Consolidations');
  const master = useMasterData();
  const localName = useLocalName();
  const types = (master?.containerTypes ?? []).filter(
    (c) => c.isActive || c.code === value?.containerTypeCode,
  );
  return (
    <div className="grid">
      <label className="field">
        <span>{t('containerType')}</span>
        <select name="containerTypeCode" required defaultValue={value?.containerTypeCode ?? ''}>
          <option value="" disabled>
            —
          </option>
          {types.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} · {localName(c)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('containerNumber')}</span>
        <input
          name="containerNumber"
          dir="ltr"
          maxLength={13}
          placeholder="ABCU1234567"
          defaultValue={value?.containerNumber ?? ''}
        />
      </label>
      <label className="field">
        <span>{t('sealNumber')}</span>
        <input name="sealNumber" dir="ltr" maxLength={30} defaultValue={value?.sealNumber ?? ''} />
      </label>
      <label className="field">
        <span>{t('carrier')}</span>
        <input name="carrierName" maxLength={200} defaultValue={value?.carrierName ?? ''} />
      </label>
      <label className="field">
        <span>{t('vessel')}</span>
        <input name="vesselName" maxLength={200} defaultValue={value?.vesselName ?? ''} />
      </label>
      <label className="field">
        <span>{t('voyage')}</span>
        <input
          name="voyageNumber"
          dir="ltr"
          maxLength={50}
          defaultValue={value?.voyageNumber ?? ''}
        />
      </label>
      <label className="field">
        <span>{t('masterBl')}</span>
        <input
          name="masterBlNumber"
          dir="ltr"
          maxLength={50}
          defaultValue={value?.masterBlNumber ?? ''}
        />
      </label>
      <label className="field">
        <span>{t('etd')}</span>
        <input name="etd" type="date" defaultValue={value?.etd ?? ''} />
      </label>
      <label className="field">
        <span>{t('eta')}</span>
        <input name="eta" type="date" defaultValue={value?.eta ?? ''} />
      </label>
    </div>
  );
}

/**
 * Search the user's shipments and pick LCL sea ones. The list is narrowed here for convenience
 * only: the API checks the mode, load type, status, branch and other containers again.
 */
export function LclShipmentPicker({
  exclude,
  onPick,
  onError,
  disabled = false,
}: {
  exclude: readonly string[];
  onPick: (shipment: ShipmentSummaryDto) => void;
  onError: (e: unknown) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Consolidations');
  const tc = useTranslations('Common');
  const master = useMasterData();
  const locationName = useLocationName(master);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ShipmentSummaryDto[] | null>(null);

  async function search() {
    try {
      const page = await api<Page<ShipmentSummaryDto>>(
        `/shipments?pageSize=50&q=${encodeURIComponent(q)}`,
      );
      setResults(page.items.filter((s) => s.mode === 'SEA' && s.loadType === 'LCL'));
    } catch (e) {
      onError(e);
    }
  }

  const shown = (results ?? []).filter((s) => !exclude.includes(s.id));
  return (
    <div className="stack">
      <div className="line">
        <label className="field grow">
          <span>{t('shipmentSearch')}</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void search();
              }
            }}
          />
        </label>
        <button type="button" onClick={() => void search()}>
          {tc('search')}
        </button>
      </div>
      {results !== null &&
        (shown.length === 0 ? (
          <p className="muted">{t('searchNoResults')}</p>
        ) : (
          <ul className="picker">
            {shown.map((s) => (
              <li key={s.id}>
                <button type="button" disabled={disabled} onClick={() => onPick(s)}>
                  <span dir="ltr">{s.number}</span>
                  <span>{s.customerName}</span>
                  <span className="muted">
                    {tc('route', {
                      from: locationName(s.originLocationId),
                      to: locationName(s.destinationLocationId),
                    })}
                  </span>
                  <StatusBadge kind="shipment" status={s.status} />
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
