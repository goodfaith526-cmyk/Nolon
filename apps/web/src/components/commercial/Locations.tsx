'use client';

import {
  LOCATION_KINDS,
  type LocationDto,
  type LocationInput,
  type LocationKind,
  type MasterDataDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { can, useMe } from '../StaffShell';
import { CountrySelect, useCountryName } from '../CountrySelect';
import { Notice, type NoticeState, useFailureText } from './Notice';

/** Ports, cities and border points (master data); each place can name the city it serves. */
export function Locations() {
  const t = useTranslations('Locations');
  const countryName = useCountryName();
  const tc = useTranslations('Common');
  const me = useMe();
  const localName = useLocalName();
  const failure = useFailureText();
  const [locations, setLocations] = useState<LocationDto[] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<LocationKind>('PORT');
  // The new location's city and country: a place with a city takes the city's country.
  const [cityId, setCityId] = useState('');
  const [country, setCountry] = useState('');

  const load = useCallback(() => {
    api<MasterDataDto>('/master-data')
      .then((d) => setLocations(d.locations))
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [failure]);

  useEffect(load, [load]);

  if (!can(me, 'master_data:view')) return <p className="error">{tc('noAccess')}</p>;

  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice({ ok: true, text: success });
      load();
      return true;
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const body: LocationInput = {
      code: field(form, 'code').trim(),
      kind,
      nameEn: field(form, 'nameEn').trim(),
      nameAr: field(form, 'nameAr').trim(),
      countryCode: field(form, 'countryCode'),
      cityId: chosenCity?.id ?? null,
    };
    const ok = await run(
      () => api<LocationDto>('/master-data/locations', { method: 'POST', body }),
      t('createdNotice'),
    );
    if (ok) {
      element.reset();
      setKind('PORT');
      setCityId('');
      setCountry('');
    }
  }

  function update(l: LocationDto, body: Partial<LocationInput>) {
    void run(() => api(`/master-data/locations/${l.id}`, { method: 'PATCH', body }), tc('saved'));
  }

  const cities = (locations ?? []).filter((l) => l.kind === 'CITY');
  // The city picked for the new place (a city has none): its country is the place's.
  const chosenCity = kind === 'CITY' ? undefined : cities.find((c) => c.id === cityId);
  const canCreate = can(me, 'master_data:create');
  const canUpdate = can(me, 'master_data:update');
  const cityName = (id: string | null) => {
    const city = id ? cities.find((c) => c.id === id) : undefined;
    return city ? localName(city) : '—';
  };
  const cityOptions = (current: string | null) =>
    cities
      .filter((c) => c.isActive || c.id === current)
      .map((c) => (
        <option key={c.id} value={c.id}>
          {localName(c)} ({c.code})
        </option>
      ));

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('hint')}</p>
        </div>
      </div>
      <Notice notice={notice} />
      {canCreate && (
        <form className="card stack" autoComplete="off" onSubmit={(e) => void onCreate(e)}>
          <h2>{t('add')}</h2>
          <div className="grid">
            <label className="field">
              <span>{t('kind')}</span>
              <select
                name="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as LocationKind)}
              >
                {LOCATION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`kind_${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('code')}</span>
              <input name="code" required maxLength={10} dir="ltr" pattern="[A-Za-z0-9]+" />
            </label>
            <label className="field">
              <span>{t('nameAr')}</span>
              <input name="nameAr" required maxLength={200} dir="rtl" />
            </label>
            <label className="field">
              <span>{t('nameEn')}</span>
              <input name="nameEn" required maxLength={200} dir="ltr" />
            </label>
            <label className="field">
              <span>{t('country')}</span>
              <CountrySelect
                name="countryCode"
                required
                locations={locations ?? undefined}
                value={chosenCity ? chosenCity.countryCode : country}
                disabled={chosenCity !== undefined}
                onChange={setCountry}
              />
              {chosenCity && (
                // A disabled select is not submitted: the city's country is sent with the form.
                <input type="hidden" name="countryCode" value={chosenCity.countryCode} />
              )}
              {chosenCity && (
                <small id="location-country-from-city" className="muted">
                  {t('countryFromCity')}
                </small>
              )}
            </label>
            {kind !== 'CITY' && (
              <label className="field">
                <span>{t('city')}</span>
                <select
                  name="cityId"
                  value={cityId}
                  onChange={(e) => {
                    setCityId(e.target.value);
                    const city = cities.find((c) => c.id === e.target.value);
                    // Kept if the city is cleared again, still editable then.
                    if (city) setCountry(city.countryCode);
                  }}
                >
                  <option value="">{t('noCity')}</option>
                  {cityOptions(null)}
                </select>
              </label>
            )}
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
          </div>
        </form>
      )}
      {locations === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : locations.length === 0 ? (
        <p className="empty">{t('none')}</p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>{t('code')}</th>
                <th>{t('name')}</th>
                <th>{t('kind')}</th>
                <th>{t('country')}</th>
                <th>{t('city')}</th>
                <th>{tc('status')}</th>
                {canUpdate && <th />}
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr key={l.id} className={l.isActive ? '' : 'inactive'}>
                  <td dir="ltr">{l.code}</td>
                  <td>{localName(l)}</td>
                  <td>{t(`kind_${l.kind}`)}</td>
                  <td>{countryName(l.countryCode)}</td>
                  <td>
                    {canUpdate && l.kind !== 'CITY' ? (
                      <select
                        aria-label={t('city')}
                        value={l.cityId ?? ''}
                        disabled={busy}
                        onChange={(e) => update(l, { cityId: e.target.value || null })}
                      >
                        <option value="">{t('noCity')}</option>
                        {cityOptions(l.cityId)}
                      </select>
                    ) : (
                      cityName(l.cityId)
                    )}
                  </td>
                  <td>{l.isActive ? tc('active') : tc('inactive')}</td>
                  {canUpdate && (
                    <td>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => update(l, { isActive: !l.isActive })}
                      >
                        {l.isActive ? tc('deactivate') : tc('activate')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
