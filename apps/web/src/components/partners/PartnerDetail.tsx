'use client';

import type { PartnerDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useCountryName } from '../CountrySelect';
import { useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { PartnerCommissions } from './PartnerCommissions';
import { PartnerContracts } from './PartnerContracts';
import { PartnerFields, partnerFields } from './Partners';

export function PartnerDetail({ id }: { id: string }) {
  const t = useTranslations('Partners');
  const countryName = useCountryName();
  const tc = useTranslations('Common');
  const me = useMe();
  const failure = useFailureText();
  const master = useMasterData();
  const localName = useLocalName();
  const locationName = useLocationName(master);
  const {
    record: partner,
    notice: loadNotice,
    setRecord,
  } = useRecord<PartnerDto>(`/partners/${id}`);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!partner) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function run(body: unknown) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(await api<PartnerDto>(`/partners/${id}`, { method: 'PATCH', body }));
      setEditing(false);
      setNotice({ ok: true, text: tc('saved') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void run(partnerFields(new FormData(e.currentTarget)));
  }

  const p = partner;
  const branch = me.branches.find((b) => b.id === p.branchId);

  return (
    <section className="stack">
      <div className="row">
        <h1>
          {p.name}{' '}
          <span className="muted" dir="ltr">
            {p.number}
          </span>
        </h1>
        <span className={`badge ${p.isActive ? 'badge-ACTIVE' : 'badge-INACTIVE'}`}>
          {p.isActive ? tc('active') : tc('inactive')}
        </span>
      </div>
      <Notice notice={notice} />
      {p.actions.canEdit && (
        <div className="actions">
          {!editing && (
            <button type="button" onClick={() => setEditing(true)}>
              {tc('edit')}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void run({ isActive: !p.isActive })}>
            {p.isActive ? tc('deactivate') : tc('activate')}
          </button>
        </div>
      )}

      {editing ? (
        <form className="card stack" autoComplete="off" onSubmit={save}>
          <PartnerFields partner={p} />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      ) : (
        <dl className="details">
          <dt>{t('kind')}</dt>
          <dd>{t(`kind_${p.kind}`)}</dd>
          <dt>{t('branch')}</dt>
          <dd>{branch ? localName(branch) : '—'}</dd>
          <dt>{t('phone')}</dt>
          <dd dir="ltr">{p.phone ?? '—'}</dd>
          <dt>{t('email')}</dt>
          <dd dir="ltr">{p.email ?? '—'}</dd>
          <dt>{t('countryCode')}</dt>
          <dd>{countryName(p.countryCode)}</dd>
          <dt>{t('location')}</dt>
          <dd>{p.locationId ? locationName(p.locationId) : '—'}</dd>
          <dt>{t('currency')}</dt>
          <dd dir="ltr">{p.currency}</dd>
          {p.notes && (
            <>
              <dt>{tc('notes')}</dt>
              <dd className="pre">{p.notes}</dd>
            </>
          )}
        </dl>
      )}
      {can(me, 'partner_contracts:view') && <PartnerContracts partner={p} />}
      {can(me, 'partner_commissions:view') && <PartnerCommissions partner={p} />}
      <p className="muted">{t('commissionsLater')}</p>
    </section>
  );
}
