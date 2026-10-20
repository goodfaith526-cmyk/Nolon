'use client';

import type {
  CarrierDto,
  CarrierInput,
  DriverDto,
  DriverInput,
  DriverUserOptionDto,
  Page as PageOf,
  SupplierSummaryDto,
  VehicleDto,
  VehicleInput,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useBranchCode } from '../finance/common';
import { can, useMe } from '../StaffShell';

/** Kilograms, as the API accepts them (up to 9 integer and 3 decimal digits). */
const KG_PATTERN = '\\d{1,9}(\\.\\d{1,3})?';
/** International phone, +E.164. */
const PHONE_PATTERN = '\\+[1-9][0-9]{6,14}';

/** Loads a list and runs changes against it, showing the outcome. */
function useList<T>(path: string) {
  const failure = useFailureText();
  const tc = useTranslations('Common');
  const [items, setItems] = useState<T[] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<T[]>(path)
      .then(setItems)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [path, failure]);

  useEffect(load, [load]);

  const run = useCallback(
    async (action: () => Promise<unknown>, success = tc('saved')): Promise<boolean> => {
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
    },
    [failure, load, tc],
  );

  return { items, notice, busy, run };
}

function Page({
  title,
  hint,
  notice,
  children,
}: {
  title: string;
  hint: string;
  notice: NoticeState | null;
  children: ReactNode;
}) {
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted">{hint}</p>
        </div>
      </div>
      <Notice notice={notice} />
      {children}
    </section>
  );
}

function ActiveToggle({
  active,
  disabled,
  onToggle,
}: {
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const tc = useTranslations('Common');
  return (
    <div className="actions">
      <span className={active ? 'badge badge-ok' : 'badge'}>
        {active ? tc('active') : tc('inactive')}
      </span>
      <button type="button" className="button small" disabled={disabled} onClick={onToggle}>
        {active ? tc('deactivate') : tc('activate')}
      </button>
    </div>
  );
}

/** Owned vehicles of the user's branches. */
export function Vehicles() {
  const t = useTranslations('Transport');
  const tc = useTranslations('Common');
  const me = useMe();
  const localName = useLocalName();
  const branchCode = useBranchCode(me);
  const { items, notice, busy, run } = useList<VehicleDto>('/transport/vehicles');

  if (!can(me, 'transport_fleet:view')) return <p className="error">{tc('noAccess')}</p>;
  const canUpdate = can(me, 'transport_fleet:update');

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const f = new FormData(element);
    const body: VehicleInput = {
      branchId: field(f, 'branchId'),
      plateNumber: field(f, 'plateNumber').trim(),
      vehicleType: field(f, 'vehicleType').trim(),
      capacityKg: field(f, 'capacityKg').trim() || null,
    };
    if (await run(() => api('/transport/vehicles', { method: 'POST', body }), t('added'))) {
      element.reset();
    }
  }

  return (
    <Page title={t('vehiclesTitle')} hint={t('vehiclesHint')} notice={notice}>
      {can(me, 'transport_fleet:create') && (
        <form className="card stack" onSubmit={(e) => void onCreate(e)}>
          <h2>{t('addVehicle')}</h2>
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
              <span>{t('plate')}</span>
              <input name="plateNumber" required maxLength={30} dir="ltr" />
            </label>
            <label className="field">
              <span>{t('vehicleType')}</span>
              <input name="vehicleType" required maxLength={100} />
            </label>
            <label className="field">
              <span>{t('capacityKg')}</span>
              <input name="capacityKg" inputMode="decimal" dir="ltr" pattern={KG_PATTERN} />
            </label>
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
          </div>
        </form>
      )}
      {items === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : items.length === 0 ? (
        <p className="empty">{t('noVehicles')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('plate')}</th>
                <th>{t('vehicleType')}</th>
                <th>{t('capacityKg')}</th>
                <th>{t('branch')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <tr key={v.id} className={v.isActive ? '' : 'inactive'}>
                  <td dir="ltr">{v.plateNumber}</td>
                  <td>{v.vehicleType}</td>
                  <td dir="ltr">{v.capacityKg ?? '—'}</td>
                  <td dir="ltr">{branchCode(v.branchId)}</td>
                  <td>
                    {canUpdate ? (
                      <ActiveToggle
                        active={v.isActive}
                        disabled={busy}
                        onToggle={() =>
                          void run(() =>
                            api(`/transport/vehicles/${v.id}`, {
                              method: 'PATCH',
                              body: { isActive: !v.isActive },
                            }),
                          )
                        }
                      />
                    ) : v.isActive ? (
                      tc('active')
                    ) : (
                      tc('inactive')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

/** Drivers of the user's branches, each optionally linked to a Driver user account. */
export function Drivers() {
  const t = useTranslations('Transport');
  const tc = useTranslations('Common');
  const me = useMe();
  const localName = useLocalName();
  const branchCode = useBranchCode(me);
  const { items, notice, busy, run } = useList<DriverDto>('/transport/drivers');
  const canUpdate = can(me, 'transport_fleet:update');
  const [users, setUsers] = useState<DriverUserOptionDto[]>([]);
  // New driver's name (functional review D6): linking a user account fills it with the user's
  // name while the person has not typed one of their own; a typed name is kept, and another user
  // replaces only a name that came from a user. The API takes whatever name is sent.
  const [name, setName] = useState('');
  const [nameFromUser, setNameFromUser] = useState(false);

  useEffect(() => {
    if (!canUpdate) return;
    let cancelled = false;
    api<DriverUserOptionDto[]>('/transport/driver-users')
      .then((list) => {
        if (!cancelled) setUsers(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canUpdate]);

  if (!can(me, 'transport_fleet:view')) return <p className="error">{tc('noAccess')}</p>;

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const f = new FormData(element);
    const body: DriverInput = {
      branchId: field(f, 'branchId'),
      name: field(f, 'name').trim(),
      phone: field(f, 'phone').trim() || null,
      licenseNumber: field(f, 'licenseNumber').trim() || null,
      userId: field(f, 'userId') || null,
    };
    if (await run(() => api('/transport/drivers', { method: 'POST', body }), t('added'))) {
      element.reset();
      setName('');
      setNameFromUser(false);
    }
  }

  function onUserPicked(userId: string) {
    const picked = users.find((u) => u.id === userId);
    if (picked && (name.trim() === '' || nameFromUser)) {
      setName(picked.fullName);
      setNameFromUser(true);
    }
  }

  const linked = new Set((items ?? []).map((d) => d.userId).filter(Boolean));

  return (
    <Page title={t('driversTitle')} hint={t('driversHint')} notice={notice}>
      {can(me, 'transport_fleet:create') && (
        <form className="card stack" onSubmit={(e) => void onCreate(e)}>
          <h2>{t('addDriver')}</h2>
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
              <span>{t('name')}</span>
              <input
                name="name"
                required
                maxLength={200}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameFromUser(false);
                }}
              />
              {nameFromUser && <small className="muted">{t('nameFromUser')}</small>}
            </label>
            <label className="field">
              <span>{t('phone')}</span>
              <input
                name="phone"
                type="tel"
                dir="ltr"
                pattern={PHONE_PATTERN}
                placeholder="+249…"
              />
            </label>
            <label className="field">
              <span>{t('license')}</span>
              <input name="licenseNumber" maxLength={50} dir="ltr" />
            </label>
            <label className="field">
              <span>{t('linkedUser')}</span>
              <select name="userId" defaultValue="" onChange={(e) => onUserPicked(e.target.value)}>
                <option value="">{t('noUser')}</option>
                {users
                  .filter((u) => !linked.has(u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName} ({u.email})
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
          </div>
        </form>
      )}
      {items === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : items.length === 0 ? (
        <p className="empty">{t('noDrivers')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('phone')}</th>
                <th>{t('license')}</th>
                <th>{t('linkedUser')}</th>
                <th>{t('branch')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className={d.isActive ? '' : 'inactive'}>
                  <td>{d.name}</td>
                  <td dir="ltr">{d.phone ?? '—'}</td>
                  <td dir="ltr">{d.licenseNumber ?? '—'}</td>
                  <td>
                    {canUpdate ? (
                      <select
                        value={d.userId ?? ''}
                        disabled={busy}
                        aria-label={t('linkedUser')}
                        onChange={(e) =>
                          void run(() =>
                            api(`/transport/drivers/${d.id}`, {
                              method: 'PATCH',
                              body: { userId: e.target.value || null },
                            }),
                          )
                        }
                      >
                        <option value="">{t('noUser')}</option>
                        {d.userId && !users.some((u) => u.id === d.userId) && (
                          <option value={d.userId}>{d.userName}</option>
                        )}
                        {users
                          .filter((u) => u.id === d.userId || !linked.has(u.id))
                          .map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.fullName}
                            </option>
                          ))}
                      </select>
                    ) : (
                      (d.userName ?? t('noUser'))
                    )}
                  </td>
                  <td dir="ltr">{branchCode(d.branchId)}</td>
                  <td>
                    {canUpdate ? (
                      <ActiveToggle
                        active={d.isActive}
                        disabled={busy}
                        onToggle={() =>
                          void run(() =>
                            api(`/transport/drivers/${d.id}`, {
                              method: 'PATCH',
                              body: { isActive: !d.isActive },
                            }),
                          )
                        }
                      />
                    ) : d.isActive ? (
                      tc('active')
                    ) : (
                      tc('inactive')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

/**
 * External carriers, shared by every branch. A carrier and the supplier whose bills settle its
 * trips stay two records, linked (functional review D3): the form and the table link a supplier
 * through the supplier's carrier link, and "create supplier" makes one from the carrier unless a
 * supplier with the same name or phone exists, which it offers to link instead.
 */
export function Carriers() {
  const t = useTranslations('Transport');
  const tc = useTranslations('Common');
  const me = useMe();
  const failure = useFailureText();
  const { items, notice, busy, run } = useList<CarrierDto>('/transport/carriers');
  const canLink = can(me, 'suppliers:view') && can(me, 'suppliers:update');
  const canCreateSupplier = canLink && can(me, 'suppliers:create');
  const [suppliers, setSuppliers] = useState<SupplierSummaryDto[]>([]);
  // Suppliers that look like the carrier's company, found before making one from it.
  const [matches, setMatches] = useState<{
    carrierId: string;
    suppliers: SupplierSummaryDto[];
  } | null>(null);
  const [extra, setExtra] = useState<NoticeState | null>(null);

  useEffect(() => {
    if (!canLink) return;
    let cancelled = false;
    api<PageOf<SupplierSummaryDto>>('/suppliers?activeOnly=true&pageSize=100')
      .then((page) => {
        if (!cancelled) setSuppliers(page.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canLink]);

  if (!can(me, 'transport_fleet:view')) return <p className="error">{tc('noAccess')}</p>;
  const canUpdate = can(me, 'transport_fleet:update');

  const link = (carrier: CarrierDto, supplierId: string) =>
    supplierId
      ? api(`/suppliers/${supplierId}/carriers/${carrier.id}`, { method: 'PUT' })
      : api(`/suppliers/${carrier.supplierId ?? ''}/carriers/${carrier.id}`, {
          method: 'DELETE',
        });

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const f = new FormData(element);
    const body: CarrierInput = {
      name: field(f, 'name').trim(),
      phone: field(f, 'phone').trim() || null,
    };
    const supplierId = field(f, 'supplierId');
    setExtra(null);
    let linkRefused: string | null = null;
    const ok = await run(async () => {
      const carrier = await api<CarrierDto>('/transport/carriers', { method: 'POST', body });
      if (!supplierId) return;
      // Two steps: a carrier is valid without a supplier. A refused link leaves it "not linked",
      // said here and in the table, where it can be linked again.
      try {
        await link(carrier, supplierId);
      } catch (e) {
        linkRefused = failure(e);
      }
    }, t('added'));
    if (!ok) return;
    element.reset();
    if (linkRefused) setExtra({ ok: false, text: t('carrierNotLinked', { reason: linkRefused }) });
  }

  async function createSupplier(carrier: CarrierDto) {
    setExtra(null);
    setMatches(null);
    try {
      const found = await api<SupplierSummaryDto[]>(`/suppliers/matching-carrier/${carrier.id}`);
      if (found.length > 0) {
        setMatches({ carrierId: carrier.id, suppliers: found });
        return;
      }
    } catch (e) {
      setExtra({ ok: false, text: failure(e) });
      return;
    }
    await run(
      () => api(`/suppliers/from-carrier/${carrier.id}`, { method: 'POST' }),
      t('supplierCreated'),
    );
  }

  return (
    <Page title={t('carriersTitle')} hint={t('carriersHint')} notice={extra ?? notice}>
      {can(me, 'transport_fleet:create') && (
        <form className="card line" onSubmit={(e) => void onCreate(e)}>
          <label className="field grow">
            <span>{t('name')}</span>
            <input name="name" required maxLength={200} />
          </label>
          <label className="field">
            <span>{t('phone')}</span>
            <input name="phone" type="tel" dir="ltr" pattern={PHONE_PATTERN} placeholder="+249…" />
          </label>
          {canLink && (
            <label className="field">
              <span>{t('supplier')}</span>
              <select name="supplierId" defaultValue="">
                <option value="">{t('noSupplier')}</option>
                {suppliers.map((sup) => (
                  <option key={sup.id} value={sup.id}>
                    {sup.name} ({sup.number})
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {t('addCarrier')}
          </button>
        </form>
      )}
      {items === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : items.length === 0 ? (
        <p className="empty">{t('noCarriers')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('phone')}</th>
                <th>{t('supplier')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className={c.isActive ? '' : 'inactive'}>
                  <td>{c.name}</td>
                  <td dir="ltr">{c.phone ?? '—'}</td>
                  <td>
                    <div className="actions">
                      {c.supplierId ? (
                        !canLink && <span>{c.supplierName}</span>
                      ) : (
                        <span className="badge badge-warn">{t('notLinked')}</span>
                      )}
                      {canLink && (
                        <select
                          value={c.supplierId ?? ''}
                          disabled={busy}
                          aria-label={t('supplier')}
                          onChange={(e) => {
                            setExtra(null);
                            void run(() => link(c, e.target.value));
                          }}
                        >
                          <option value="">{t('noSupplier')}</option>
                          {c.supplierId && !suppliers.some((sup) => sup.id === c.supplierId) && (
                            <option value={c.supplierId}>{c.supplierName}</option>
                          )}
                          {suppliers.map((sup) => (
                            <option key={sup.id} value={sup.id}>
                              {sup.name} ({sup.number})
                            </option>
                          ))}
                        </select>
                      )}
                      {canCreateSupplier && !c.supplierId && (
                        <button
                          type="button"
                          className="button small"
                          disabled={busy}
                          onClick={() => void createSupplier(c)}
                        >
                          {t('createSupplier')}
                        </button>
                      )}
                    </div>
                    {matches?.carrierId === c.id && (
                      <div className="stack">
                        <p className="muted">{t('supplierExists')}</p>
                        <div className="actions">
                          {matches.suppliers.map((sup) => (
                            <button
                              key={sup.id}
                              type="button"
                              className="button small"
                              disabled={busy || !sup.isActive}
                              onClick={() => {
                                setMatches(null);
                                void run(() => link(c, sup.id));
                              }}
                            >
                              {t('linkTo', { supplier: `${sup.name} (${sup.number})` })}
                              {!sup.isActive && ` · ${tc('inactive')}`}
                            </button>
                          ))}
                          <button type="button" onClick={() => setMatches(null)}>
                            {tc('back')}
                          </button>
                        </div>
                      </div>
                    )}
                  </td>
                  <td>
                    {canUpdate ? (
                      <ActiveToggle
                        active={c.isActive}
                        disabled={busy}
                        onToggle={() =>
                          void run(() =>
                            api(`/transport/carriers/${c.id}`, {
                              method: 'PATCH',
                              body: { isActive: !c.isActive },
                            }),
                          )
                        }
                      />
                    ) : c.isActive ? (
                      tc('active')
                    ) : (
                      tc('inactive')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
