'use client';

import type {
  CarrierDto,
  DriverDto,
  DriverLastVehicleDto,
  Page,
  ShipmentDto,
  ShipmentSummaryDto,
  TripDto,
  TripInput,
  TripKind,
  VehicleDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { branchCurrency } from '@/lib/branches';
import { field } from '@/lib/form';
import { isPlace, useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { toIso } from './common';

interface Fleet {
  vehicles: VehicleDto[];
  drivers: DriverDto[];
  carriers: CarrierDto[];
}

/**
 * New trip: route, own vehicle and driver or a hired carrier, and the shipments it carries.
 * Opened from a shipment (`shipmentId`, functional review D2), it starts with that shipment
 * picked and suggests the trip from it (see below); every value stays editable.
 */
export function TripForm({ shipmentId }: { shipmentId?: string } = {}) {
  const t = useTranslations('Transport');
  const tc = useTranslations('Common');
  const me = useMe();
  const master = useMasterData();
  const localName = useLocalName();
  const locationName = useLocationName(master);
  const failure = useFailureText();
  const router = useRouter();
  // The shipment the form was opened from (D2), loaded once when the form opens.
  const [fromShipment, setFromShipment] = useState<ShipmentDto | null>(null);
  // Branch: the person's pick, else the shipment's branch (or a branch sharing it) when it is one
  // of theirs, else their first branch. A pick is kept; the API checks the branch on save.
  const [branchChoice, setBranchChoice] = useState<string | null>(null);
  const shipmentBranch = fromShipment
    ? [fromShipment.branchId, ...fromShipment.sharedBranchIds].find((id) =>
        me.branches.some((b) => b.id === id),
      )
    : undefined;
  const branchId = branchChoice ?? shipmentBranch ?? me.branches[0]?.id ?? '';
  const [kind, setKind] = useState<TripKind>('OWN');
  // Route: the person's pick, else a suggestion from the shipment the form was opened from while
  // it is still picked: origin from where the shipment is now (not always where the trip starts,
  // so it is shown as a suggestion), destination from the shipment's destination. Removing the
  // shipment drops the suggestions; a pick is kept.
  const [originChoice, setOriginChoice] = useState<string | null>(null);
  const [destinationChoice, setDestinationChoice] = useState<string | null>(null);
  // Own trip: driver and vehicle as picked, else the branch's first driver, and the vehicle of
  // that driver's latest trip (D8, from the API) as a suggestion, else the first vehicle. The
  // suggestion follows the driver until the person picks a vehicle, which is kept; changing the
  // branch clears both picks.
  const [driverChoice, setDriverChoice] = useState<string | null>(null);
  const [vehicleChoice, setVehicleChoice] = useState<string | null>(null);
  const [lastVehicle, setLastVehicle] = useState<{
    driverId: string;
    found: DriverLastVehicleDto['lastVehicle'];
  } | null>(null);
  // An external trip's agreed currency starts as the branch's (functional review C5), read from
  // /auth/me and following the branch until the person picks the agreed one (null until then),
  // which is kept.
  const [currencyChoice, setCurrency] = useState<string | null>(null);
  const currency = currencyChoice ?? branchCurrency(me, branchId);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ShipmentSummaryDto[] | null>(null);
  const [picked, setPicked] = useState<ShipmentSummaryDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    if (!shipmentId) return;
    let cancelled = false;
    api<ShipmentDto>(`/shipments/${shipmentId}`)
      .then((shipment) => {
        if (cancelled) return;
        setFromShipment(shipment);
        setPicked((list) => (list.some((p) => p.id === shipment.id) ? list : [...list, shipment]));
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [shipmentId, failure]);

  // Dropdown narrowing only: the API checks branch, activity and the shipments again.
  const vehicles = (fleet?.vehicles ?? []).filter((v) => v.isActive && v.branchId === branchId);
  const drivers = (fleet?.drivers ?? []).filter((d) => d.isActive && d.branchId === branchId);
  const driverId = driverChoice ?? drivers[0]?.id ?? '';

  useEffect(() => {
    if (!driverId || kind !== 'OWN') return;
    let cancelled = false;
    api<DriverLastVehicleDto>(`/transport/drivers/${driverId}/last-vehicle`)
      .then((r) => {
        if (!cancelled) setLastVehicle({ driverId, found: r.lastVehicle });
      })
      .catch(() => {
        // Only a suggestion: without it the person picks the vehicle.
        if (!cancelled) setLastVehicle({ driverId, found: null });
      });
    return () => {
      cancelled = true;
    };
  }, [driverId, kind]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<VehicleDto[]>('/transport/vehicles'),
      api<DriverDto[]>('/transport/drivers'),
      api<CarrierDto[]>('/transport/carriers'),
    ])
      .then(([vehicles, drivers, carriers]) => {
        if (!cancelled) setFleet({ vehicles, drivers, carriers });
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [failure]);

  if (!can(me, 'transport_trips:create')) return <p className="error">{tc('noAccess')}</p>;

  async function search() {
    try {
      const page = await api<Page<ShipmentSummaryDto>>(
        `/shipments?pageSize=20&q=${encodeURIComponent(q)}`,
      );
      setResults(page.items);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (picked.length === 0) {
      setNotice({ ok: false, text: t('noShipmentsPicked') });
      return;
    }
    const f = new FormData(event.currentTarget);
    const text = (name: string) => field(f, name).trim() || null;
    const body: TripInput = {
      branchId,
      kind,
      originLocationId: field(f, 'originLocationId'),
      destinationLocationId: field(f, 'destinationLocationId'),
      plannedDeparture: toIso(field(f, 'plannedDeparture')) ?? null,
      plannedArrival: toIso(field(f, 'plannedArrival')) ?? null,
      notes: text('notes'),
      shipmentIds: picked.map((s) => s.id),
      ...(kind === 'OWN'
        ? { vehicleId: field(f, 'vehicleId'), driverId: field(f, 'driverId') }
        : {
            carrierId: field(f, 'carrierId'),
            agreedCost: field(f, 'agreedCost').trim(),
            currency,
            externalVehicle: text('externalVehicle'),
            externalDriver: text('externalDriver'),
          }),
    };
    setBusy(true);
    setNotice(null);
    try {
      const trip = await api<TripDto>('/trips', { method: 'POST', body });
      router.push(`/trips/${trip.id}`);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
      setBusy(false);
    }
  }

  const carriers = (fleet?.carriers ?? []).filter((c) => c.isActive);
  const locations = (master?.locations ?? []).filter((l) => l.isActive && isPlace(l));
  const currencies = (master?.currencies ?? []).filter((c) => c.isActive);
  const fleetMissing = fleet !== null && kind === 'OWN' && (!vehicles.length || !drivers.length);
  const isLocation = (id: string | null | undefined): id is string =>
    !!id && locations.some((l) => l.id === id);
  const suggesting = fromShipment && picked.some((p) => p.id === fromShipment.id);
  const suggestedOrigin =
    suggesting && isLocation(fromShipment.currentLocationId) ? fromShipment.currentLocationId : '';
  const suggestedDestination =
    suggesting && isLocation(fromShipment.destinationLocationId)
      ? fromShipment.destinationLocationId
      : '';
  const origin = originChoice ?? suggestedOrigin;
  const destination = destinationChoice ?? suggestedDestination;
  const lastFound = lastVehicle?.driverId === driverId ? lastVehicle.found : null;
  const suggestedVehicle =
    lastFound && vehicles.some((v) => v.id === lastFound.vehicleId) ? lastFound : null;
  const vehicleId = vehicleChoice ?? suggestedVehicle?.vehicleId ?? vehicles[0]?.id ?? '';

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('newTrip')}</h1>
          <p className="muted">{t('newTripHint')}</p>
        </div>
        <Link href="/trips" className="button">
          {tc('back')}
        </Link>
      </div>
      <Notice notice={notice} />
      <form className="card stack" onSubmit={(e) => void onSubmit(e)}>
        <div className="grid">
          <label className="field">
            <span>{t('branch')}</span>
            <select
              value={branchId}
              onChange={(e) => {
                setBranchChoice(e.target.value);
                setDriverChoice(null);
                setVehicleChoice(null);
              }}
              required
            >
              {me.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} · {localName(b)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('origin')}</span>
            <select
              name="originLocationId"
              required
              value={origin}
              onChange={(e) => setOriginChoice(e.target.value)}
            >
              <option value="" disabled>
                —
              </option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {localName(l)} ({l.code})
                </option>
              ))}
            </select>
            {originChoice === null && suggestedOrigin && (
              <small className="muted">{t('originFromShipment')}</small>
            )}
          </label>
          <label className="field">
            <span>{t('destination')}</span>
            <select
              name="destinationLocationId"
              required
              value={destination}
              onChange={(e) => setDestinationChoice(e.target.value)}
            >
              <option value="" disabled>
                —
              </option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {localName(l)} ({l.code})
                </option>
              ))}
            </select>
            {destinationChoice === null && suggestedDestination && (
              <small className="muted">{t('destinationFromShipment')}</small>
            )}
          </label>
          <label className="field">
            <span>{t('plannedDeparture')}</span>
            <input name="plannedDeparture" type="datetime-local" />
          </label>
          <label className="field">
            <span>{t('plannedArrival')}</span>
            <input name="plannedArrival" type="datetime-local" />
          </label>
        </div>

        <fieldset className="stack">
          <legend>{t('kind')}</legend>
          <div className="checks">
            {(['OWN', 'EXTERNAL'] as const).map((k) => (
              <label key={k}>
                <input
                  type="radio"
                  name="kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                {t(`kind_${k}`)}
              </label>
            ))}
          </div>
          {kind === 'OWN' ? (
            <div className="grid">
              <label className="field">
                <span>{t('vehicle')}</span>
                <select
                  name="vehicleId"
                  required
                  value={vehicleId}
                  onChange={(e) => setVehicleChoice(e.target.value)}
                >
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.plateNumber} · {v.vehicleType}
                    </option>
                  ))}
                </select>
                {vehicleChoice === null && suggestedVehicle && (
                  <small className="muted">
                    {t('vehicleFromLastTrip', { trip: suggestedVehicle.tripNumber })}
                  </small>
                )}
              </label>
              <label className="field">
                <span>{t('driver')}</span>
                <select
                  name="driverId"
                  required
                  value={driverId}
                  onChange={(e) => setDriverChoice(e.target.value)}
                >
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <div className="grid">
              <label className="field">
                <span>{t('carrier')}</span>
                <select name="carrierId" required>
                  {carriers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('agreedCost')}</span>
                <input
                  name="agreedCost"
                  required
                  inputMode="decimal"
                  dir="ltr"
                  pattern={AMOUNT_PATTERN}
                  // A cost entered is in the currency shown then: another branch no longer
                  // changes it (Codex F94-2).
                  onChange={() => {
                    if (currencyChoice === null) setCurrency(currency);
                  }}
                />
              </label>
              <label className="field">
                <span>{t('currency')}</span>
                <select
                  name="currency"
                  required
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('externalVehicle')}</span>
                <input name="externalVehicle" maxLength={100} dir="ltr" />
              </label>
              <label className="field">
                <span>{t('externalDriver')}</span>
                <input name="externalDriver" maxLength={200} />
              </label>
            </div>
          )}
          {fleetMissing && <p className="muted">{t('fleetMissing')}</p>}
        </fieldset>

        <fieldset className="stack">
          <legend>{t('pickShipments')}</legend>
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
            (results.length === 0 ? (
              <p className="muted">{t('searchNoResults')}</p>
            ) : (
              <ul className="picker">
                {results
                  .filter((s) => !picked.some((p) => p.id === s.id))
                  .map((s) => (
                    <li key={s.id}>
                      <button type="button" onClick={() => setPicked([...picked, s])}>
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
          {picked.length === 0 ? (
            <p className="muted">{t('noShipmentsPicked')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('shipment')}</th>
                    <th>{t('customer')}</th>
                    <th>{tc('status')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {picked.map((s) => (
                    <tr key={s.id}>
                      <td dir="ltr">{s.number}</td>
                      <td>{s.customerName}</td>
                      <td>
                        <StatusBadge kind="shipment" status={s.status} />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button small"
                          onClick={() => setPicked(picked.filter((p) => p.id !== s.id))}
                        >
                          {tc('remove')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </fieldset>

        <label className="field">
          <span>{tc('notes')}</span>
          <textarea name="notes" maxLength={2000} rows={2} />
        </label>
        <p className="muted">{t('scheduleHint')}</p>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy || fleet === null}>
            {t('createTrip')}
          </button>
        </div>
      </form>
    </section>
  );
}
