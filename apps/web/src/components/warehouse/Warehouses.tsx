'use client';

import type {
  StorageLocationInput,
  WarehouseDto,
  WarehouseInput,
  WarehouseStockDto,
  WarehouseUpdateRequest,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { isPlace, useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useBranchCode } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';

/** Pattern for warehouse and storage location codes: letters and digits, dash-separated. */
const CODE_PATTERN = '[A-Za-z0-9]+(-[A-Za-z0-9]+)*';

/**
 * Warehouses of the user's branches: the shipments each holds now (its goods receipts less its
 * releases), the shipments whose status says they are in a warehouse with no receipt yet, and
 * the warehouses' storage locations (master data).
 */
export function Warehouses() {
  const t = useTranslations('Warehouse');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const me = useMe();
  const localName = useLocalName();
  const master = useMasterData();
  const locationName = useLocationName(master);
  // The place a warehouse is at: a receipt that moves the shipment records it there (review D9).
  const places = master?.locations.filter((l) => l.isActive && isPlace(l)) ?? [];
  const branchCode = useBranchCode(me);
  const failure = useFailureText();
  const [warehouses, setWarehouses] = useState<WarehouseDto[] | null>(null);
  const [stock, setStock] = useState<WarehouseStockDto | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<WarehouseDto[]>('/warehouses')
      .then(setWarehouses)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    api<WarehouseStockDto>('/warehouses/stock')
      .then(setStock)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [failure]);

  useEffect(load, [load]);

  if (!can(me, 'warehouse:view')) return <p className="error">{tc('noAccess')}</p>;

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
    const body: WarehouseInput = {
      branchId: field(form, 'branchId'),
      code: field(form, 'code').trim(),
      nameEn: field(form, 'nameEn').trim(),
      nameAr: field(form, 'nameAr').trim(),
      address: field(form, 'address').trim() || null,
      locationId: field(form, 'locationId') || null,
    };
    const ok = await run(
      () => api<WarehouseDto>('/warehouses', { method: 'POST', body }),
      t('createdNotice'),
    );
    if (ok) element.reset();
  }

  function update(w: WarehouseDto, body: WarehouseUpdateRequest) {
    void run(() => api(`/warehouses/${w.id}`, { method: 'PATCH', body }), tc('saved'));
  }

  async function onAddLocation(event: FormEvent<HTMLFormElement>, w: WarehouseDto) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const body: StorageLocationInput = {
      code: field(form, 'code').trim(),
      name: field(form, 'name').trim() || null,
    };
    const ok = await run(
      () => api(`/warehouses/${w.id}/locations`, { method: 'POST', body }),
      tc('saved'),
    );
    if (ok) element.reset();
  }

  function toggleLocation(w: WarehouseDto, locationId: string, isActive: boolean) {
    void run(
      () =>
        api(`/warehouses/${w.id}/locations/${locationId}`, {
          method: 'PATCH',
          body: { isActive },
        }),
      tc('saved'),
    );
  }

  const canUpdate = can(me, 'warehouse:update');
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('hint')}</p>
        </div>
      </div>
      <Notice notice={notice} />
      {stock && stock.awaitingReceipt.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('awaitingTitle', { count: stock.awaitingReceipt.length })}</h2>
              <p className="muted">{t('awaitingHint')}</p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>{t('stockShipment')}</th>
                <th>{t('stockCustomer')}</th>
                <th>{t('branch')}</th>
                <th>{tc('status')}</th>
                <th>{t('awaitingSince')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stock.awaitingReceipt.map((a) => (
                <tr key={a.shipmentId}>
                  <td dir="ltr">
                    <Link href={`/shipments/${a.shipmentId}`}>{a.shipmentNumber}</Link>
                  </td>
                  <td>{a.customerName}</td>
                  <td dir="ltr">{a.branchCode}</td>
                  <td>
                    <StatusBadge kind="shipment" status={a.status} />
                  </td>
                  <td>{dateTime.format(new Date(a.statusAt))}</td>
                  <td>
                    <Link href={`/shipments/${a.shipmentId}#warehouse`}>{t('awaitingOpen')}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(me, 'warehouse:create') && (
        <form className="card stack" onSubmit={(e) => void onCreate(e)}>
          <h2>{t('add')}</h2>
          <div className="grid">
            <label className="field">
              <span>{t('branch')}</span>
              <select name="branchId" required>
                {me.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} · {localName(b)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('code')}</span>
              <input name="code" required maxLength={20} dir="ltr" pattern={CODE_PATTERN} />
            </label>
            <label className="field">
              <span>{t('nameAr')}</span>
              <input name="nameAr" required maxLength={200} dir="rtl" />
            </label>
            <label className="field">
              <span>{t('nameEn')}</span>
              <input name="nameEn" required maxLength={200} dir="ltr" />
            </label>
          </div>
          <label className="field">
            <span>{t('address')}</span>
            <input name="address" maxLength={500} />
          </label>
          <label className="field">
            <span>{t('place')}</span>
            <select name="locationId" defaultValue="">
              <option value="">{t('noPlace')}</option>
              {places.map((l) => (
                <option key={l.id} value={l.id}>
                  {localName(l)} ({l.code})
                </option>
              ))}
            </select>
            <small className="muted">{t('placeHint')}</small>
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
          </div>
        </form>
      )}
      {warehouses === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : warehouses.length === 0 ? (
        <p className="empty">{t('none')}</p>
      ) : (
        warehouses.map((w) => (
          <div key={w.id} className={w.isActive ? 'panel' : 'panel inactive'}>
            <div className="panel-head">
              <div>
                <h2>
                  {localName(w)}{' '}
                  <span className="muted" dir="ltr">
                    {w.code}
                  </span>
                </h2>
                <p className="muted">
                  {branchCode(w.branchId)}
                  {w.address ? ` · ${w.address}` : ''}
                  {` · ${t('place')}: ${w.locationId ? locationName(w.locationId) : t('noPlace')}`}
                </p>
              </div>
              <div className="actions">
                <span className={w.isActive ? 'badge badge-ok' : 'badge'}>
                  {w.isActive ? tc('active') : tc('inactive')}
                </span>
                {canUpdate && (
                  <select
                    aria-label={t('place')}
                    value={w.locationId ?? ''}
                    disabled={busy}
                    onChange={(e) => update(w, { locationId: e.target.value || null })}
                  >
                    <option value="">{t('noPlace')}</option>
                    {places.map((l) => (
                      <option key={l.id} value={l.id}>
                        {localName(l)} ({l.code})
                      </option>
                    ))}
                    {/* A place deactivated since stays shown until another is picked. */}
                    {w.locationId && !places.some((l) => l.id === w.locationId) && (
                      <option value={w.locationId}>{locationName(w.locationId)}</option>
                    )}
                  </select>
                )}
                {canUpdate && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => update(w, { isActive: !w.isActive })}
                  >
                    {w.isActive ? tc('deactivate') : tc('activate')}
                  </button>
                )}
              </div>
            </div>
            <WarehouseStock stock={stock} warehouseId={w.id} />
            {w.storageLocations.length === 0 ? (
              <p className="empty">{t('noLocations')}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t('locationCode')}</th>
                    <th>{t('locationName')}</th>
                    <th>{tc('status')}</th>
                    {canUpdate && <th />}
                  </tr>
                </thead>
                <tbody>
                  {w.storageLocations.map((l) => (
                    <tr key={l.id} className={l.isActive ? '' : 'inactive'}>
                      <td dir="ltr">{l.code}</td>
                      <td>{l.name ?? '—'}</td>
                      <td>{l.isActive ? tc('active') : tc('inactive')}</td>
                      {canUpdate && (
                        <td>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => toggleLocation(w, l.id, !l.isActive)}
                          >
                            {l.isActive ? tc('deactivate') : tc('activate')}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {canUpdate && (
              <form className="line panel-body" onSubmit={(e) => void onAddLocation(e, w)}>
                <label className="field">
                  <span>{t('locationCode')}</span>
                  <input name="code" required maxLength={20} dir="ltr" pattern={CODE_PATTERN} />
                </label>
                <label className="field grow">
                  <span>{t('locationName')}</span>
                  <input name="name" maxLength={200} />
                </label>
                <button type="submit" disabled={busy}>
                  {t('addLocation')}
                </button>
              </form>
            )}
          </div>
        ))
      )}
    </section>
  );
}

/** The shipments a warehouse holds now, longest held first (from GET /warehouses/stock). */
function WarehouseStock({
  stock,
  warehouseId,
}: {
  stock: WarehouseStockDto | null;
  warehouseId: string;
}) {
  const t = useTranslations('Warehouse');
  const tc = useTranslations('Common');
  if (!stock) return <p className="muted">{tc('loading')}</p>;
  const rows = stock.rows.filter((r) => r.warehouseId === warehouseId);
  const packages = rows.reduce((n, r) => n + r.packages, 0);
  return (
    <div className="panel-body stack">
      <h3>{t('stockTitle', { shipments: rows.length, packages })}</h3>
      {rows.length === 0 ? (
        <p className="empty">{t('stockNone')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('stockShipment')}</th>
              <th>{t('stockCustomer')}</th>
              <th>{t('packages')}</th>
              <th>{t('weightKg')}</th>
              <th>{t('stockSince')}</th>
              <th>{t('stockDays')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.shipmentId}>
                <td dir="ltr">
                  <Link href={`/shipments/${r.shipmentId}#warehouse`}>{r.shipmentNumber}</Link>
                </td>
                <td>{r.customerName}</td>
                <td dir="ltr">{r.packages}</td>
                <td dir="ltr">{r.weightKg}</td>
                <td dir="ltr">{r.heldSince}</td>
                <td dir="ltr">{r.daysHeld}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {stock.truncated && <p className="muted">{t('stockTruncated')}</p>}
    </div>
  );
}
