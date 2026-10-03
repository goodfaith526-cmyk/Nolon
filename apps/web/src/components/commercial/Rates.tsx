'use client';

import {
  CARGO_TYPES,
  LOAD_TYPES,
  RATE_STATUSES,
  RATE_UNITS,
  SHIPPING_MODES,
  type Page,
  type RateCardDto,
  type RateStatus,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { can, useMe } from '../StaffShell';
import { Notice, type NoticeState, useFailureText } from './Notice';

export function Rates() {
  const t = useTranslations('Rates');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const failure = useFailureText();
  const [status, setStatus] = useState<RateStatus | ''>('');
  const [page, setPage] = useState<Page<RateCardDto> | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    const filter = status ? `&status=${status}` : '';
    api<Page<RateCardDto>>(`/rates?pageSize=100${filter}`)
      .then(setPage)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [status, failure]);

  useEffect(load, [load]);

  if (!can(me, 'rates:view')) return <p className="error">{tc('noAccess')}</p>;

  async function act(rate: RateCardDto, action: 'approve' | 'cancel') {
    setNotice(null);
    try {
      await api(`/rates/${rate.id}/${action}`, { method: 'POST' });
      setNotice({ ok: true, text: action === 'approve' ? t('approved') : t('cancelled') });
      load();
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {!creating && can(me, 'rates:create') && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            {t('add')}
          </button>
        )}
      </div>
      <p className="muted">{t('workflow')}</p>
      <Notice notice={notice} />
      {creating && (
        <RateForm
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            setNotice({ ok: true, text: t('created') });
            load();
          }}
        />
      )}
      <label className="field inline">
        {tc('status')}
        <select value={status} onChange={(e) => setStatus(e.target.value as RateStatus | '')}>
          <option value="">{tc('all')}</option>
          {RATE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`rate_${s}`)}
            </option>
          ))}
        </select>
      </label>
      {page === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : page.items.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('route')}</th>
                <th>{t('mode')}</th>
                <th>{t('cargo')}</th>
                <th>{t('price')}</th>
                <th>{t('validity')}</th>
                <th>{tc('status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {page.items.map((r) => (
                <tr key={r.id} className={r.status === 'CANCELLED' ? 'inactive' : ''}>
                  <td>
                    {tc('route', {
                      from: locationName(r.originLocationId),
                      to: locationName(r.destinationLocationId),
                    })}
                  </td>
                  <td>
                    {te(`mode_${r.mode}`)}
                    {r.loadType ? ` · ${r.loadType}` : ''}
                  </td>
                  <td>
                    {te(`cargo_${r.cargoType}`)}
                    {r.containerTypeCode ? ` · ${r.containerTypeCode}` : ''}
                    <div className="muted">{r.chargeTypeCode}</div>
                  </td>
                  <td dir="ltr">
                    {r.price} {r.currency} / {te(`unit_${r.unit}`)}
                    {r.minimumCharge !== '0' ? (
                      <div className="muted">
                        {t('minimum')}: {r.minimumCharge}
                      </div>
                    ) : null}
                  </td>
                  <td dir="ltr">
                    {r.validFrom} → {r.validTo ?? '∞'}
                  </td>
                  <td>{te(`rate_${r.status}`)}</td>
                  <td>
                    <div className="actions">
                      {r.status === 'DRAFT' && can(me, 'rates:approve') && (
                        <button type="button" onClick={() => void act(r, 'approve')}>
                          {t('approve')}
                        </button>
                      )}
                      {r.status !== 'CANCELLED' && can(me, 'rates:cancel') && (
                        <button type="button" onClick={() => void act(r, 'cancel')}>
                          {t('cancel')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RateForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const t = useTranslations('Rates');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const [mode, setMode] = useState<string>('SEA');
  const [cargo, setCargo] = useState<string>('CONTAINER');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const transitDays = field(form, 'transitDays');
    const body = {
      branchId: field(form, 'branchId'),
      originLocationId: field(form, 'originLocationId'),
      destinationLocationId: field(form, 'destinationLocationId'),
      mode,
      loadType: mode === 'SEA' ? field(form, 'loadType') || null : null,
      cargoType: cargo,
      containerTypeCode: cargo === 'CONTAINER' ? field(form, 'containerTypeCode') : null,
      chargeTypeCode: field(form, 'chargeTypeCode'),
      unit: field(form, 'unit'),
      price: field(form, 'price'),
      minimumCharge: field(form, 'minimumCharge') || '0',
      currency: field(form, 'currency'),
      validFrom: field(form, 'validFrom'),
      validTo: field(form, 'validTo') || null,
      transitDays: transitDays ? Number.parseInt(transitDays, 10) : null,
      notes: field(form, 'notes') || null,
    };
    setBusy(true);
    setNotice(null);
    try {
      await api('/rates', { method: 'POST', body });
      onSaved();
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!master) return <p className="muted">{tc('loading')}</p>;
  const locations = master.locations.filter((l) => l.isActive);

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h2>{t('add')}</h2>
      <Notice notice={notice} />
      <div className="grid">
        <label className="field">
          {t('branch')}
          <select name="branchId" required>
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {name(b)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('origin')}
          <select name="originLocationId" required>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {name(l)} ({l.code})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('destination')}
          <select name="destinationLocationId" required defaultValue={locations[1]?.id}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {name(l)} ({l.code})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('mode')}
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {SHIPPING_MODES.map((m) => (
              <option key={m} value={m}>
                {te(`mode_${m}`)}
              </option>
            ))}
          </select>
        </label>
        {mode === 'SEA' && (
          <label className="field">
            {t('loadType')}
            <select name="loadType">
              {LOAD_TYPES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          {t('cargo')}
          <select value={cargo} onChange={(e) => setCargo(e.target.value)}>
            {CARGO_TYPES.map((c) => (
              <option key={c} value={c}>
                {te(`cargo_${c}`)}
              </option>
            ))}
          </select>
        </label>
        {cargo === 'CONTAINER' && (
          <label className="field">
            {t('containerType')}
            <select name="containerTypeCode">
              {master.containerTypes
                .filter((c) => c.isActive)
                .map((c) => (
                  <option key={c.code} value={c.code}>
                    {name(c)}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field">
          {t('chargeType')}
          <select name="chargeTypeCode" defaultValue="FREIGHT">
            {master.chargeTypes
              .filter((c) => c.isActive)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {name(c)}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          {t('unit')}
          <select name="unit">
            {RATE_UNITS.map((u) => (
              <option key={u} value={u}>
                {te(`unit_${u}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('price')}
          <input
            name="price"
            required
            inputMode="decimal"
            dir="ltr"
            pattern="\d{1,14}(\.\d{1,4})?"
          />
        </label>
        <label className="field">
          {t('minimum')}
          <input
            name="minimumCharge"
            inputMode="decimal"
            dir="ltr"
            pattern="\d{1,14}(\.\d{1,4})?"
          />
        </label>
        <label className="field">
          {t('currency')}
          <select name="currency" defaultValue="USD">
            {master.currencies
              .filter((c) => c.isActive)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          {t('validFrom')}
          <input name="validFrom" type="date" required />
        </label>
        <label className="field">
          {t('validTo')}
          <input name="validTo" type="date" />
        </label>
        <label className="field">
          {t('transitDays')}
          <input name="transitDays" type="number" min={0} max={365} />
        </label>
      </div>
      <label className="field">
        {tc('notes')}
        <textarea name="notes" maxLength={2000} />
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {tc('save')}
        </button>
        <button type="button" onClick={onCancel}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
