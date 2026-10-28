'use client';

import {
  PARTNER_KINDS,
  type Page,
  type PartnerDto,
  type PartnerInput,
  type PartnerKind,
  type PartnerSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { isPlace, useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { usePagedLoads } from '@/lib/paged-loads';
import { CountrySelect, useCountryName } from '../CountrySelect';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';

const PAGE_SIZE = 50;

/** The partner form's fields as the API takes them (all but the branch); empty texts are null. */
export function partnerFields(form: FormData): Omit<PartnerInput, 'branchId'> {
  const text = (name: string) => field(form, name).trim() || null;
  return {
    kind: field(form, 'kind') as PartnerKind,
    name: field(form, 'name').trim(),
    phone: text('phone'),
    email: text('email'),
    countryCode: field(form, 'countryCode'),
    locationId: text('locationId'),
    currency: field(form, 'currency'),
    notes: text('notes'),
  };
}

/** Kind, name, contact, country, city or port and currency: the fields a partner keeps. */
export function PartnerFields({ partner }: { partner?: PartnerDto }) {
  const t = useTranslations('Partners');
  const tc = useTranslations('Common');
  const master = useMasterData();
  const localName = useLocalName();
  const me = useMe();
  const [country, setCountry] = useState(partner?.countryCode ?? '');
  const [locationId, setLocationId] = useState(partner?.locationId ?? '');
  const places = (master?.locations ?? []).filter(
    (l) => (l.isActive || l.id === partner?.locationId) && isPlace(l) && l.countryCode === country,
  );
  const currencies = (master?.currencies ?? []).filter(
    (c) => c.isActive || c.code === partner?.currency,
  );
  return (
    <>
      <div className="grid">
        <label className="field">
          {t('kind')}
          <select name="kind" required defaultValue={partner?.kind ?? 'SALES_OUTLET'}>
            {PARTNER_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind_${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('name')}
          <input
            name="name"
            required
            maxLength={200}
            autoComplete="off"
            defaultValue={partner?.name}
          />
        </label>
        <label className="field">
          {t('phone')}
          <input
            name="phone"
            dir="ltr"
            autoComplete="off"
            placeholder="+966..."
            defaultValue={partner?.phone ?? ''}
          />
        </label>
        <label className="field">
          {t('email')}
          <input
            name="email"
            type="email"
            dir="ltr"
            autoComplete="off"
            defaultValue={partner?.email ?? ''}
          />
        </label>
        <label className="field">
          {t('countryCode')}
          <CountrySelect
            name="countryCode"
            required
            locations={master?.locations}
            value={country}
            onChange={(code) => {
              setCountry(code);
              setLocationId('');
            }}
          />
        </label>
        <label className="field">
          {t('location')}
          <select
            name="locationId"
            autoComplete="off"
            disabled={country === '' || places.length === 0}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            aria-describedby="partner-location-hint"
          >
            <option value="">{t('noLocation')}</option>
            {places.map((l) => (
              <option key={l.id} value={l.id}>
                {localName(l)} ({l.code})
              </option>
            ))}
          </select>
          {country === '' ? (
            <small id="partner-location-hint" className="muted">
              {t('chooseCountryFirst')}
            </small>
          ) : (
            master !== null &&
            places.length === 0 && (
              <small id="partner-location-hint" className="muted">
                {t('noPlacesInCountry')}{' '}
                {can(me, 'master_data:create') && <Link href="/locations">{t('addPlace')}</Link>}
              </small>
            )
          )}
        </label>
        <label className="field">
          {t('currency')}
          <select name="currency" required defaultValue={partner?.currency ?? ''}>
            <option value="" disabled>
              —
            </option>
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        {tc('notes')}
        <textarea name="notes" maxLength={2000} defaultValue={partner?.notes ?? ''} />
      </label>
    </>
  );
}

/**
 * Partners of the network: sales outlets, consolidators, overseas agents and distributors, owned by
 * a branch. Master data only for now: commissions and settlements come later.
 */
export function Partners() {
  const t = useTranslations('Partners');
  const tc = useTranslations('Common');
  const me = useMe();
  const router = useRouter();
  const failure = useFailureText();
  const master = useMasterData();
  const localName = useLocalName();
  const locationName = useLocationName(master);
  const countryName = useCountryName();
  const single = me.branches.length === 1 ? me.branches[0] : undefined;
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<PartnerKind | ''>('');
  const [page, setPage] = useState<Page<PartnerSummaryDto> | null>(null);
  const [adding, setAdding] = useState(false);
  const [branchId, setBranchId] = useState(single?.id ?? me.branches[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  // The filters of the rows shown, so "show more" fetches the next page of the same search.
  const [shown, setShown] = useState<{ q: string; kind: PartnerKind | '' }>({ q: '', kind: '' });

  const { loads, loading } = usePagedLoads();

  /**
   * Page 1 replaces the rows; a later page is added below them, one at a time. A reply overtaken
   * by a newer search is dropped.
   */
  const load = useCallback(
    (query: string, k: PartnerKind | '', pageNo = 1) => {
      const token = pageNo > 1 ? loads.next() : loads.first();
      if (token === null) return;
      const params = new URLSearchParams({
        pageSize: String(PAGE_SIZE),
        page: String(pageNo),
        q: query,
      });
      if (k) params.set('kind', k);
      api<Page<PartnerSummaryDto>>(`/partners?${params.toString()}`)
        .then((next) => {
          if (!loads.current(token)) return;
          setShown({ q: query, kind: k });
          setPage((prev) =>
            pageNo > 1 && prev ? { ...next, items: [...prev.items, ...next.items] } : next,
          );
        })
        .catch((e: unknown) => {
          if (loads.current(token)) setNotice({ ok: false, text: failure(e) });
        })
        .finally(() => loads.done(token));
    },
    [failure, loads],
  );

  useEffect(() => load('', ''), [load]);

  if (!can(me, 'partners:view')) return <p className="error">{tc('noAccess')}</p>;

  const branchLabel = (id: string) => {
    const branch = me.branches.find((b) => b.id === id);
    return branch ? localName(branch) : '';
  };

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<PartnerDto>('/partners', {
        method: 'POST',
        body: { ...partnerFields(new FormData(e.currentTarget)), branchId },
      });
      router.push(`/partners/${saved.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      <div className="row">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('hint')}</p>
        </div>
        {can(me, 'partners:create') && !adding && (
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            {t('add')}
          </button>
        )}
      </div>
      <Notice notice={notice} />
      {adding && (
        <form className="card stack" autoComplete="off" onSubmit={(e) => void create(e)}>
          <h2>{t('add')}</h2>
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
                    {localName(b)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <PartnerFields />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          load(q, kind);
        }}
      >
        <input
          type="search"
          value={q}
          placeholder={t('search')}
          aria-label={t('search')}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          value={kind}
          aria-label={t('kind')}
          onChange={(e) => {
            const k = e.target.value as PartnerKind | '';
            setKind(k);
            load(q, k);
          }}
        >
          <option value="">{t('allKinds')}</option>
          {PARTNER_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`kind_${k}`)}
            </option>
          ))}
        </select>
        <button type="submit">{tc('search')}</button>
      </form>
      {page === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : page.items.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('name')}</th>
                <th>{t('kind')}</th>
                <th>{t('countryCode')}</th>
                <th>{t('location')}</th>
                <th>{t('branch')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((p) => (
                <tr key={p.id} className={p.isActive ? '' : 'inactive'}>
                  <td dir="ltr">
                    <Link href={`/partners/${p.id}`}>{p.number}</Link>
                  </td>
                  <td>{p.name}</td>
                  <td>{t(`kind_${p.kind}`)}</td>
                  <td>{countryName(p.countryCode)}</td>
                  <td>{p.locationId ? locationName(p.locationId) : '—'}</td>
                  <td>{branchLabel(p.branchId)}</td>
                  <td>{p.isActive ? tc('active') : tc('inactive')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{tc('shown', { shown: page.items.length, total: page.total })}</p>
          {page.items.length < page.total && (
            <button
              type="button"
              disabled={loading}
              onClick={() => load(shown.q, shown.kind, page.page + 1)}
            >
              {t('loadMore')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
