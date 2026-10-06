'use client';

import {
  CONSOLIDATION_BASES,
  type ConsolidationBasis,
  type ConsolidationDto,
  type ConsolidationInput,
  type ShipmentSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { ConsolidationDetailFields, LclShipmentPicker } from './common';

/** New consolidated container: branch, port to port, container details and its first shipments. */
export function ConsolidationForm() {
  const t = useTranslations('Consolidations');
  const tc = useTranslations('Common');
  const me = useMe();
  const master = useMasterData();
  const localName = useLocalName();
  const failure = useFailureText();
  const router = useRouter();
  const [branchId, setBranchId] = useState(me.branches[0]?.id ?? '');
  const [picked, setPicked] = useState<ShipmentSummaryDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!can(me, 'consolidation:create')) return <p className="error">{tc('noAccess')}</p>;
  if (!master) return <p className="muted">{tc('loading')}</p>;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (name: string) => field(f, name).trim() || null;
    const body: ConsolidationInput = {
      branchId,
      originLocationId: field(f, 'originLocationId'),
      destinationLocationId: field(f, 'destinationLocationId'),
      containerTypeCode: field(f, 'containerTypeCode'),
      containerNumber: text('containerNumber'),
      sealNumber: text('sealNumber'),
      carrierName: text('carrierName'),
      vesselName: text('vesselName'),
      voyageNumber: text('voyageNumber'),
      masterBlNumber: text('masterBlNumber'),
      etd: text('etd'),
      eta: text('eta'),
      basis: field(f, 'basis') as ConsolidationBasis,
      notes: text('notes'),
      shipmentIds: picked.map((s) => s.id),
    };
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<ConsolidationDto>('/consolidations', { method: 'POST', body });
      router.push(`/consolidations/${saved.id}`);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
      setBusy(false);
    }
  }

  const ports = master.locations.filter((l) => l.isActive && l.kind === 'PORT');
  const portSelect = (name: string) => (
    <select name={name} required defaultValue="">
      <option value="" disabled>
        —
      </option>
      {ports.map((l) => (
        <option key={l.id} value={l.id}>
          {localName(l)} ({l.code})
        </option>
      ))}
    </select>
  );

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('new')}</h1>
          <p className="muted">{t('newHint')}</p>
        </div>
        <Link href="/consolidations" className="button">
          {tc('back')}
        </Link>
      </div>
      <Notice notice={notice} />
      <form className="card stack" onSubmit={(e) => void onSubmit(e)}>
        <div className="grid">
          <label className="field">
            <span>{t('branch')}</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} required>
              {me.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} · {localName(b)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('originPort')}</span>
            {portSelect('originLocationId')}
          </label>
          <label className="field">
            <span>{t('destinationPort')}</span>
            {portSelect('destinationLocationId')}
          </label>
          <label className="field">
            <span>{t('basis')}</span>
            <select name="basis" defaultValue="CBM">
              {CONSOLIDATION_BASES.map((b) => (
                <option key={b} value={b}>
                  {t(`basis_${b}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ConsolidationDetailFields value={null} />

        <fieldset className="stack">
          <legend>{t('pickShipments')}</legend>
          <p className="muted">{t('pickHint')}</p>
          <LclShipmentPicker
            exclude={picked.map((s) => s.id)}
            onPick={(s) => setPicked([...picked, s])}
            onError={(e) => setNotice({ ok: false, text: failure(e) })}
          />
          {picked.length === 0 ? (
            <p className="muted">{t('noShipmentsPicked')}</p>
          ) : (
            <ul className="plain">
              {picked.map((s) => (
                <li key={s.id} className="line">
                  <span dir="ltr">{s.number}</span>
                  <span>{s.customerName}</span>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => setPicked(picked.filter((p) => p.id !== s.id))}
                  >
                    {tc('remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <label className="field">
          <span>{tc('notes')}</span>
          <textarea name="notes" maxLength={2000} rows={2} />
        </label>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {t('create')}
          </button>
        </div>
      </form>
    </section>
  );
}
