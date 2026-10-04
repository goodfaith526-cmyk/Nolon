'use client';

import type {
  Page,
  PodDto,
  ShipmentPodsDto,
  ShipmentSummaryDto,
  TripCostShareDto,
  TripDto,
  TripExpenseRequest,
  TripMove,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { failureStatus, useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN, FX_RATE_PATTERN, todayString } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money, useBranchCode, useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { PodForm } from './PodForm';
import { TripKindLabel, toIso, useDateTime } from './common';

/** One trip: its progress, shipments (with POD), and its costs. The API decides every action. */
export function TripDetail({ id }: { id: string }) {
  const t = useTranslations('Transport');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const localName = useLocalName();
  const locationName = useLocationName(master);
  const branchCode = useBranchCode(me);
  const dateTime = useDateTime();
  const failure = useFailureText();
  const { record: trip, notice: loadNotice, setRecord } = useRecord<TripDto>(`/trips/${id}`);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [addingExpense, setAddingExpense] = useState(false);
  // One id per expense form: a retry of the same submit cannot post the expense twice.
  const [expenseRequestId, setExpenseRequestId] = useState('');
  const [expenseAccount, setExpenseAccount] = useState('');
  const [cancelExpenseId, setCancelExpenseId] = useState<string | null>(null);
  const [pod, setPod] = useState<{
    shipmentId: string;
    actions: ShipmentPodsDto['actions'];
  } | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ShipmentSummaryDto[] | null>(null);

  if (!trip) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }
  const a = trip.actions;

  async function run(
    action: () => Promise<TripDto>,
    success: string,
    conflict?: string,
  ): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(await action());
      setNotice({ ok: true, text: success });
      return true;
    } catch (e) {
      const refused = conflict !== undefined && failureStatus(e) === 409;
      setNotice({ ok: false, text: refused ? conflict : failure(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function onMove(event: FormEvent<HTMLFormElement>, move: TripMove) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void run(
      () =>
        api<TripDto>(`/trips/${id}/status`, {
          method: 'POST',
          body: { status: move, occurredAt: toIso(field(f, 'occurredAt')) },
        }),
      t('movedNotice', { status: te(`trip_${move}`) }),
      t('moveRefused'),
    );
  }

  async function onCancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = field(new FormData(event.currentTarget), 'reason').trim();
    const ok = await run(
      () => api<TripDto>(`/trips/${id}/cancel`, { method: 'POST', body: { reason } }),
      t('cancelledNotice'),
    );
    if (ok) setCancelling(false);
  }

  async function searchShipments() {
    try {
      const page = await api<Page<ShipmentSummaryDto>>(
        `/shipments?pageSize=20&q=${encodeURIComponent(q)}`,
      );
      setResults(page.items);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  async function addShipment(shipmentId: string) {
    const ok = await run(
      () => api<TripDto>(`/trips/${id}/shipments`, { method: 'POST', body: { shipmentId } }),
      tc('saved'),
    );
    if (ok) setResults(null);
  }

  function removeShipment(shipmentId: string) {
    void run(
      () => api<TripDto>(`/trips/${id}/shipments/${shipmentId}`, { method: 'DELETE' }),
      tc('saved'),
    );
  }

  async function openPod(shipmentId: string) {
    setNotice(null);
    try {
      const view = await api<ShipmentPodsDto>(`/shipments/${shipmentId}/pods`);
      setPod({ shipmentId, actions: view.actions });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  async function onPodSaved(saved: PodDto) {
    setPod(null);
    setNotice({
      ok: true,
      text: saved.statusApplied
        ? t('podSavedMoved', {
            number: saved.number,
            status: te(`shipment_${saved.statusApplied}`),
          })
        : t('podSaved', { number: saved.number }),
    });
    try {
      setRecord(await api<TripDto>(`/trips/${id}`));
    } catch {
      // The POD is saved; the page shows it on the next load.
    }
  }

  async function onExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trip) return;
    const f = new FormData(event.currentTarget);
    const account = trip.cashAccounts.find((c) => c.id === field(f, 'cashAccountId'));
    if (!account) return;
    const body: TripExpenseRequest = {
      requestId: expenseRequestId,
      expenseDate: field(f, 'expenseDate'),
      description: field(f, 'description').trim(),
      amount: field(f, 'amount').trim(),
      currency: account.currency,
      fxRate: field(f, 'fxRate').trim() || null,
      cashAccountId: account.id,
    };
    const ok = await run(
      () => api<TripDto>(`/trips/${id}/expenses`, { method: 'POST', body }),
      t('expensePosted'),
    );
    if (ok) setAddingExpense(false);
  }

  async function onCancelExpense(event: FormEvent<HTMLFormElement>, expenseId: string) {
    event.preventDefault();
    const reason = field(new FormData(event.currentTarget), 'reason').trim();
    const ok = await run(
      () =>
        api<TripDto>(`/trips/${id}/expenses/${expenseId}/cancel`, {
          method: 'POST',
          body: { reason },
        }),
      t('expenseCancelled'),
    );
    if (ok) setCancelExpenseId(null);
  }

  const journalLink = (entryId: string, number: string) =>
    can(me, 'manual_journals:view') ? (
      <Link href={`/accounting/journals/${entryId}`} dir="ltr">
        {number}
      </Link>
    ) : (
      <span dir="ltr">{number}</span>
    );

  const shares = (list: TripCostShareDto[], currency: string) => (
    <ul className="plain">
      {list.map((s) => (
        <li key={s.shipmentId}>
          <span dir="ltr">{s.shipmentNumber}</span>: <Money value={s.amount} currency={currency} />
        </li>
      ))}
    </ul>
  );

  const selectedAccount =
    trip.cashAccounts.find((c) => c.id === expenseAccount) ?? trip.cashAccounts[0];

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1 dir="ltr" className="title-number">
            {trip.number}
          </h1>
          <p className="actions">
            <StatusBadge kind="trip" status={trip.status} />
            <TripKindLabel kind={trip.kind} />
          </p>
        </div>
        <Link href="/trips" className="button">
          {tc('back')}
        </Link>
      </div>
      <Notice notice={notice} />

      {(a.moves.length > 0 || a.canCancel) && (
        <div className="card stack">
          {a.moves.map((move) => (
            <form key={move} className="line trip-move" onSubmit={(e) => onMove(e, move)}>
              <label className="field">
                <span>{t('occurredAt')}</span>
                <input name="occurredAt" type="datetime-local" />
              </label>
              <button type="submit" className="primary big" disabled={busy}>
                {t(`move_${move}`)}
              </button>
            </form>
          ))}
          {a.moves.some((m) => m !== 'COMPLETED') && <p className="muted">{t('moveHint')}</p>}
          {a.canCancel &&
            (cancelling ? (
              <form className="line" onSubmit={(e) => void onCancel(e)}>
                <label className="field grow">
                  <span>{t('cancelReason')}</span>
                  <input name="reason" required maxLength={1000} />
                </label>
                <button type="submit" disabled={busy}>
                  {t('confirmCancel')}
                </button>
                <button type="button" onClick={() => setCancelling(false)}>
                  {tc('back')}
                </button>
              </form>
            ) : (
              <div className="actions">
                <button type="button" onClick={() => setCancelling(true)}>
                  {t('cancelTrip')}
                </button>
              </div>
            ))}
        </div>
      )}

      <dl className="details trip-details">
        <dt>{t('branch')}</dt>
        <dd dir="ltr">{branchCode(trip.branchId)}</dd>
        <dt>{t('route')}</dt>
        <dd>
          {tc('route', {
            from: locationName(trip.originLocationId),
            to: locationName(trip.destinationLocationId),
          })}
        </dd>
        <dt>{t('vehicle')}</dt>
        <dd dir="ltr">{trip.vehicleLabel ?? '—'}</dd>
        <dt>{t('driver')}</dt>
        <dd>{trip.driverLabel ?? '—'}</dd>
        {trip.kind === 'EXTERNAL' && (
          <>
            <dt>{t('carrier')}</dt>
            <dd>{trip.carrierName}</dd>
            <dt>{t('agreedCost')}</dt>
            <dd>
              {trip.agreedCost && <Money value={trip.agreedCost} currency={trip.currency ?? ''} />}
            </dd>
          </>
        )}
        <dt>{t('plannedDeparture')}</dt>
        <dd>{dateTime(trip.plannedDeparture)}</dd>
        <dt>{t('plannedArrival')}</dt>
        <dd>{dateTime(trip.plannedArrival)}</dd>
        <dt>{t('actualDeparture')}</dt>
        <dd>{dateTime(trip.actualDeparture)}</dd>
        <dt>{t('actualArrival')}</dt>
        <dd>{dateTime(trip.actualArrival)}</dd>
        {trip.completedAt && (
          <>
            <dt>{t('completedAt')}</dt>
            <dd>{dateTime(trip.completedAt)}</dd>
          </>
        )}
        {trip.cancelReason && (
          <>
            <dt>{t('cancelReason')}</dt>
            <dd className="pre">{trip.cancelReason}</dd>
          </>
        )}
        {trip.notes && (
          <>
            <dt>{tc('notes')}</dt>
            <dd className="pre">{trip.notes}</dd>
          </>
        )}
        <dt>{t('createdBy')}</dt>
        <dd>{trip.createdByName}</dd>
      </dl>

      <div className="panel">
        <div className="panel-head">
          <h2>{t('shipmentsSection')}</h2>
        </div>
        <ul className="trip-stops">
          {trip.shipments.map((s) => (
            <li key={s.shipmentId} className="trip-stop">
              <div className="row">
                <div>
                  {can(me, 'shipments:view') ? (
                    <Link href={`/shipments/${s.shipmentId}`} dir="ltr">
                      <strong>{s.shipmentNumber}</strong>
                    </Link>
                  ) : (
                    <strong dir="ltr">{s.shipmentNumber}</strong>
                  )}
                  <div>{s.customerName}</div>
                  <div className="muted">
                    {t('to')}: {locationName(s.destinationLocationId)}
                  </div>
                </div>
                <StatusBadge kind="shipment" status={s.status} />
              </div>
              <div className="muted">
                {t('packages')}: {s.packages}
                {s.weightKg && (
                  <>
                    {' · '}
                    {t('weightKg')}: <bdi dir="ltr">{s.weightKg}</bdi>
                  </>
                )}
                {s.volumeCbm && (
                  <>
                    {' · '}
                    {t('volumeCbm')}: <bdi dir="ltr">{s.volumeCbm}</bdi>
                  </>
                )}
              </div>
              <div className="actions">
                {s.canRecordPod && pod?.shipmentId !== s.shipmentId && (
                  <button
                    type="button"
                    className="primary big"
                    onClick={() => void openPod(s.shipmentId)}
                  >
                    {t('recordPod')}
                  </button>
                )}
                {a.canEditShipments && trip.shipments.length > 1 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeShipment(s.shipmentId)}
                  >
                    {t('removeShipment')}
                  </button>
                )}
              </div>
              {pod?.shipmentId === s.shipmentId &&
                (pod.actions.canRecord ? (
                  <PodForm
                    shipmentId={s.shipmentId}
                    actions={pod.actions}
                    tripId={trip.id}
                    onSaved={(saved) => void onPodSaved(saved)}
                    onCancel={() => setPod(null)}
                  />
                ) : (
                  <p className="muted">{t('podNotNow')}</p>
                ))}
            </li>
          ))}
        </ul>
        {a.canEditShipments && (
          <div className="panel-body stack">
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
                      void searchShipments();
                    }
                  }}
                />
              </label>
              <button type="button" onClick={() => void searchShipments()}>
                {tc('search')}
              </button>
            </div>
            {results !== null &&
              (results.length === 0 ? (
                <p className="muted">{t('searchNoResults')}</p>
              ) : (
                <ul className="picker">
                  {results
                    .filter((r) => !trip.shipments.some((s) => s.shipmentId === r.id))
                    .map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void addShipment(r.id)}
                        >
                          <span dir="ltr">{r.number}</span>
                          <span>{r.customerName}</span>
                          <StatusBadge kind="shipment" status={r.status} />
                        </button>
                      </li>
                    ))}
                </ul>
              ))}
          </div>
        )}
      </div>

      {trip.kind === 'OWN' ? (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('expensesSection')}</h2>
              <p className="muted">{t('expensesHint')}</p>
            </div>
            {a.canAddExpense && !addingExpense && (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setExpenseRequestId(crypto.randomUUID());
                  setAddingExpense(true);
                }}
              >
                {t('addExpense')}
              </button>
            )}
          </div>
          {addingExpense &&
            (trip.cashAccounts.length === 0 ? (
              <p className="panel-body muted">{t('noCashAccounts')}</p>
            ) : (
              <form className="panel-body stack" onSubmit={(e) => void onExpense(e)}>
                <div className="grid">
                  <label className="field">
                    <span>{t('expenseDate')}</span>
                    <input name="expenseDate" type="date" required defaultValue={todayString()} />
                  </label>
                  <label className="field">
                    <span>{t('description')}</span>
                    <input name="description" required maxLength={200} />
                  </label>
                  <label className="field">
                    <span>{t('cashAccount')}</span>
                    <select
                      name="cashAccountId"
                      required
                      value={selectedAccount?.id ?? ''}
                      onChange={(e) => setExpenseAccount(e.target.value)}
                    >
                      {trip.cashAccounts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} · {localName(c)} ({c.currency})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>
                      {t('amount')} ({selectedAccount?.currency})
                    </span>
                    <input
                      name="amount"
                      required
                      inputMode="decimal"
                      dir="ltr"
                      pattern={AMOUNT_PATTERN}
                    />
                  </label>
                  {selectedAccount?.currency !== 'USD' && (
                    <label className="field">
                      <span>{t('fxRate')}</span>
                      <input
                        name="fxRate"
                        inputMode="decimal"
                        dir="ltr"
                        pattern={FX_RATE_PATTERN}
                        placeholder={t('fxRateHint')}
                      />
                    </label>
                  )}
                </div>
                <div className="actions">
                  <button type="submit" className="primary" disabled={busy}>
                    {t('postExpense')}
                  </button>
                  <button type="button" onClick={() => setAddingExpense(false)}>
                    {tc('back')}
                  </button>
                </div>
              </form>
            ))}
          {trip.expenses.length === 0 ? (
            <p className="empty">{t('noExpenses')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('number')}</th>
                  <th>{t('expenseDate')}</th>
                  <th>{t('description')}</th>
                  <th>{t('amount')}</th>
                  <th>{t('shares')}</th>
                  <th>{t('journal')}</th>
                  <th>{tc('status')}</th>
                </tr>
              </thead>
              <tbody>
                {trip.expenses.map((e) => (
                  <tr key={e.id} className={e.status === 'CANCELLED' ? 'inactive' : ''}>
                    <td dir="ltr">{e.number}</td>
                    <td dir="ltr">{e.expenseDate}</td>
                    <td>
                      {e.description}
                      <div className="muted">
                        <bdi dir="ltr">{e.cashAccountCode}</bdi> · {e.createdByName}
                      </div>
                    </td>
                    <td>
                      <Money value={e.amount} currency={e.currency} />
                    </td>
                    <td>{shares(e.shares, e.currency)}</td>
                    <td>{journalLink(e.journalEntryId, e.journalNumber)}</td>
                    <td>
                      <div className="stack tight">
                        <StatusBadge kind="tripExpense" status={e.status} />
                        {e.cancelReason && <span className="muted">{e.cancelReason}</span>}
                        {a.canCancelExpense &&
                          e.status === 'POSTED' &&
                          (cancelExpenseId === e.id ? (
                            <form
                              className="stack tight"
                              onSubmit={(ev) => void onCancelExpense(ev, e.id)}
                            >
                              <input
                                name="reason"
                                required
                                maxLength={1000}
                                placeholder={t('cancelReason')}
                              />
                              <button type="submit" className="button small" disabled={busy}>
                                {t('cancelExpense')}
                              </button>
                            </form>
                          ) : (
                            <button
                              type="button"
                              className="button small"
                              onClick={() => setCancelExpenseId(e.id)}
                            >
                              {t('cancelExpense')}
                            </button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('accrualSection')}</h2>
              <p className="muted">{t('accrualHint')}</p>
            </div>
          </div>
          <div className="panel-body stack">
            {trip.accrualJournalEntryId && trip.accrualJournalNumber ? (
              <>
                <p>
                  {t('accrualPosted')}{' '}
                  {journalLink(trip.accrualJournalEntryId, trip.accrualJournalNumber)}
                </p>
                {shares(trip.accrualShares, trip.currency ?? '')}
              </>
            ) : (
              <p className="muted">{t('accrualPending')}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
