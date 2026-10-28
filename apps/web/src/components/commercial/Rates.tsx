'use client';

import {
  LOAD_TYPES,
  OFFERED_CARGO_TYPES,
  RATE_STATUSES,
  RATE_UNITS,
  hasSeaLeg,
  loadTypeOf,
  type CargoType,
  type LoadType,
  type Page,
  type RateCardDto,
  type RateStatus,
  type ShippingMode,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { onlyBranch } from '@/lib/branches';
import { field } from '@/lib/form';
import { useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { can, useMe } from '../StaffShell';
import { Money } from '../finance/common';
import { StatusBadge } from '../StatusBadge';
import { ModePicker } from './ModePicker';
import { RateCosts } from './RateCosts';
import { Notice, type NoticeState, useFailureText } from './Notice';

export function Rates() {
  const t = useTranslations('Rates');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const name = useLocalName();
  const locationName = useLocationName(master);
  const failure = useFailureText();
  const [status, setStatus] = useState<RateStatus | ''>('');
  const [page, setPage] = useState<Page<RateCardDto> | null>(null);
  const [creating, setCreating] = useState(false);
  const [costing, setCosting] = useState<RateCardDto | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    const filter = status ? `&status=${status}` : '';
    api<Page<RateCardDto>>(`/rates?pageSize=100${filter}`)
      .then(setPage)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [status, failure]);

  useEffect(load, [load]);

  if (!can(me, 'rates:view')) return <p className="error">{tc('noAccess')}</p>;

  // Every branch reads the rate cards; a rate is changed by a user of its own branch.
  const ofMine = (r: RateCardDto) => me.allBranches || me.branches.some((b) => b.id === r.branchId);
  // A country scope says so: its card prices every place of the country (plan 5.3).
  const scoped = (id: string) =>
    master?.locations.find((l) => l.id === id)?.kind === 'COUNTRY'
      ? `${locationName(id)} (${t('countryScope')})`
      : locationName(id);
  const categoryName = (code: string) => {
    const category = master?.priceCategories.find((c) => c.code === code);
    return category ? name(category) : code;
  };
  const branchName = (id: string) => {
    const branch = master?.branches.find((b) => b.id === id);
    return branch ? name(branch) : '';
  };

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
          <div className="actions">
            <Link className="button" href="/rates/import">
              {t('import')}
            </Link>
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              {t('add')}
            </button>
          </div>
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
      {costing && <RateCosts key={costing.id} rate={costing} onClose={() => setCosting(null)} />}
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
                <th>{t('branch')}</th>
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
                  <td>{branchName(r.branchId)}</td>
                  <td>
                    {tc('route', {
                      from: scoped(r.originLocationId),
                      to: scoped(r.destinationLocationId),
                    })}
                  </td>
                  <td>
                    {te(`mode_${r.mode}`)}
                    {r.loadType ? ` · ${r.loadType}` : ''}
                  </td>
                  <td>
                    {te(`cargo_${r.cargoType}`)}
                    {r.containerTypeCode ? ` · ${r.containerTypeCode}` : ''}
                    {r.priceCategoryCode ? ` · ${categoryName(r.priceCategoryCode)}` : ''}
                    <div className="muted">{r.chargeTypeCode}</div>
                  </td>
                  <td dir="ltr">
                    <Money value={r.price} currency={r.currency} /> / {te(`unit_${r.unit}`)}
                    {r.minimumCharge !== '0' ? (
                      <div className="muted">
                        {t('minimum')}: <Money value={r.minimumCharge} />
                      </div>
                    ) : null}
                  </td>
                  <td dir="ltr">
                    {r.validFrom} → {r.validTo ?? '∞'}
                  </td>
                  <td>
                    <StatusBadge kind="rate" status={r.status} />
                  </td>
                  <td>
                    <div className="actions">
                      {ofMine(r) && can(me, 'rate_costs:view') && (
                        <button type="button" onClick={() => setCosting(r)}>
                          {t('costsAndMargin')}
                        </button>
                      )}
                      {r.status === 'DRAFT' && ofMine(r) && can(me, 'rates:approve') && (
                        <button type="button" onClick={() => void act(r, 'approve')}>
                          {t('approve')}
                        </button>
                      )}
                      {r.status !== 'CANCELLED' && ofMine(r) && can(me, 'rates:cancel') && (
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
  const [mode, setMode] = useState<ShippingMode>('SEA');
  const [cargo, setCargo] = useState<CargoType>('CONTAINER');
  // FCL/LCL follows the cargo type until the person picks one (functional review B2), as quotations.
  const [loadTypeChoice, setLoadType] = useState<LoadType | null>(null);
  const loadType = hasSeaLeg(mode) ? (loadTypeChoice ?? loadTypeOf(mode, cargo)) : null;
  // With one branch the user is not asked (functional review B7); the API checks it on save.
  const single = onlyBranch(me);
  const [branchId, setBranchId] = useState(single?.id ?? me.branches[0]?.id ?? '');
  // Valid-from starts at the chosen branch's today (functional review B4), from /auth/me, and
  // follows the branch until the person types a date (null until then), which is kept.
  const [validFromChoice, setValidFrom] = useState<string | null>(null);
  const validFrom = validFromChoice ?? me.branches.find((b) => b.id === branchId)?.today ?? '';
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const transitDays = field(form, 'transitDays');
    const body = {
      branchId,
      originLocationId: field(form, 'originLocationId'),
      destinationLocationId: field(form, 'destinationLocationId'),
      mode,
      loadType,
      cargoType: cargo,
      containerTypeCode: cargo === 'CONTAINER' ? field(form, 'containerTypeCode') : null,
      chargeTypeCode: field(form, 'chargeTypeCode'),
      priceCategoryCode: field(form, 'priceCategoryCode') || null,
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
  // A card may price a whole country (plan 5.3): the narrower card (city, then place) wins.
  const locations = master.locations.filter((l) => l.isActive);
  const locationLabel = (l: (typeof locations)[number]) =>
    `${name(l)} (${l.code})${l.kind === 'COUNTRY' ? ` · ${t('countryScope')}` : ''}`;
  // A category follows one cargo type; a card without one is general (plan 5.3).
  const categories = master.priceCategories.filter((c) => c.isActive && c.cargoType === cargo);

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h2>{t('add')}</h2>
      <Notice notice={notice} />
      <div className="grid">
        {!single && (
          <label className="field">
            {t('branch')}
            <select
              name="branchId"
              required
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              {me.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {name(b)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          {t('origin')}
          <select name="originLocationId" required>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {locationLabel(l)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('destination')}
          <select name="destinationLocationId" required defaultValue={locations[1]?.id}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {locationLabel(l)}
              </option>
            ))}
          </select>
        </label>
        <ModePicker label={t('mode')} value={mode} onChange={setMode} />
        {hasSeaLeg(mode) && (
          <label className="field">
            {t('loadType')}
            <select
              value={loadType ?? ''}
              onChange={(e) => setLoadType(e.target.value as LoadType)}
            >
              {LOAD_TYPES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            {loadTypeChoice === null && <small className="muted">{tc('loadTypeFollows')}</small>}
          </label>
        )}
        <label className="field">
          {t('cargo')}
          <select value={cargo} onChange={(e) => setCargo(e.target.value as CargoType)}>
            {OFFERED_CARGO_TYPES.map((c) => (
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
          {t('priceCategory')}
          <select name="priceCategoryCode" key={cargo} defaultValue="">
            <option value="">{t('generalCategory')}</option>
            {categories.map((c) => (
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
          <input
            name="validFrom"
            type="date"
            required
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
          />
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
