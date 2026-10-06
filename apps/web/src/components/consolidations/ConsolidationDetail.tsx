'use client';

import {
  CONSOLIDATION_BASES,
  type ConsolidationBasis,
  type ConsolidationDto,
  type ConsolidationMove,
  type ConsolidationUpdateRequest,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, Fragment, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { failureStatus, useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money, useBranchCode, useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { toIso, useDateTime } from '../transport/common';
import { ConsolidationDetailFields, LclShipmentPicker } from './common';

/** One container: its moves, shipments, details and (for those who see costs) its cost sharing. */
export function ConsolidationDetail({ id }: { id: string }) {
  const t = useTranslations('Consolidations');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const branchCode = useBranchCode(me);
  const dateTime = useDateTime();
  const failure = useFailureText();
  const {
    record: c,
    notice: loadNotice,
    setRecord,
  } = useRecord<ConsolidationDto>(`/consolidations/${id}`);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  if (!c) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }
  const a = c.actions;

  async function run(
    action: () => Promise<ConsolidationDto>,
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
      setNotice({ ok: false, text: refused ? `${conflict} ${failure(e)}` : failure(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function onMove(event: FormEvent<HTMLFormElement>, move: ConsolidationMove) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void run(
      () =>
        api<ConsolidationDto>(`/consolidations/${id}/status`, {
          method: 'POST',
          body: { status: move, occurredAt: toIso(field(f, 'occurredAt')) },
        }),
      t('movedNotice', { status: te(`consolidation_${move}`) }),
      t('moveRefused'),
    );
  }

  async function onEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (name: string) => field(f, name).trim() || null;
    const body: ConsolidationUpdateRequest = {
      containerTypeCode: field(f, 'containerTypeCode'),
      containerNumber: text('containerNumber'),
      sealNumber: text('sealNumber'),
      carrierName: text('carrierName'),
      vesselName: text('vesselName'),
      voyageNumber: text('voyageNumber'),
      masterBlNumber: text('masterBlNumber'),
      etd: text('etd'),
      eta: text('eta'),
      notes: text('notes'),
      ...(a.canEditShipments ? { basis: field(f, 'basis') as ConsolidationBasis } : {}),
    };
    const ok = await run(
      () => api<ConsolidationDto>(`/consolidations/${id}`, { method: 'PATCH', body }),
      tc('saved'),
    );
    if (ok) setEditing(false);
  }

  async function onCancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = field(new FormData(event.currentTarget), 'reason').trim();
    const ok = await run(
      () =>
        api<ConsolidationDto>(`/consolidations/${id}/cancel`, {
          method: 'POST',
          body: { reason },
        }),
      t('cancelledNotice'),
    );
    if (ok) setCancelling(false);
  }

  const journalLink = (entryId: string, number: string) =>
    can(me, 'manual_journals:view') ? (
      <Link href={`/accounting/journals/${entryId}`} dir="ltr">
        {number}
      </Link>
    ) : (
      <span dir="ltr">{number}</span>
    );

  const stamps: [string, string | null][] = [
    ['closedAt', c.closedAt],
    ['loadedAt', c.loadedAt],
    ['departedAt', c.departedAt],
    ['arrivedAt', c.arrivedAt],
    ['deconsolidatedAt', c.deconsolidatedAt],
    ['cancelledAt', c.cancelledAt],
  ];

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1 dir="ltr" className="title-number">
            {c.number}
          </h1>
          <p className="actions">
            <StatusBadge kind="consolidation" status={c.status} />
          </p>
        </div>
        <div className="actions">
          {a.canEdit && !editing && (
            <button type="button" onClick={() => setEditing(true)}>
              {t('edit')}
            </button>
          )}
          <Link href="/consolidations" className="button">
            {tc('back')}
          </Link>
        </div>
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
          {a.moves.length > 0 && <p className="muted">{t(`moveHint_${a.moves[0]}`)}</p>}
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
                  {t('cancel')}
                </button>
              </div>
            ))}
        </div>
      )}

      {editing ? (
        <form className="card stack" onSubmit={(e) => void onEdit(e)}>
          <ConsolidationDetailFields value={c} />
          {a.canEditShipments && (
            <label className="field">
              <span>{t('basis')}</span>
              <select name="basis" defaultValue={c.basis}>
                {CONSOLIDATION_BASES.map((b) => (
                  <option key={b} value={b}>
                    {t(`basis_${b}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>{tc('notes')}</span>
            <textarea name="notes" maxLength={2000} rows={2} defaultValue={c.notes ?? ''} />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              {tc('back')}
            </button>
          </div>
        </form>
      ) : (
        <dl className="details trip-details">
          <dt>{t('branch')}</dt>
          <dd dir="ltr">{branchCode(c.branchId)}</dd>
          <dt>{t('route')}</dt>
          <dd>
            {tc('route', {
              from: locationName(c.originLocationId),
              to: locationName(c.destinationLocationId),
            })}
          </dd>
          <dt>{t('container')}</dt>
          <dd dir="ltr">
            {c.containerTypeCode}
            {c.containerNumber ? ` · ${c.containerNumber}` : ''}
          </dd>
          <dt>{t('sealNumber')}</dt>
          <dd dir="ltr">{c.sealNumber ?? '—'}</dd>
          <dt>{t('carrier')}</dt>
          <dd>{c.carrierName ?? '—'}</dd>
          <dt>{t('vessel')}</dt>
          <dd>
            <bdi>{c.vesselName ?? '—'}</bdi>
            {c.voyageNumber && (
              <>
                {' · '}
                <bdi dir="ltr">{c.voyageNumber}</bdi>
              </>
            )}
          </dd>
          <dt>{t('masterBl')}</dt>
          <dd dir="ltr">{c.masterBlNumber ?? '—'}</dd>
          <dt>{t('etd')}</dt>
          <dd dir="ltr">{c.etd ?? '—'}</dd>
          <dt>{t('eta')}</dt>
          <dd dir="ltr">{c.eta ?? '—'}</dd>
          <dt>{t('basis')}</dt>
          <dd>{t(`basis_${c.basis}`)}</dd>
          {stamps
            .filter(([, at]) => at !== null)
            .map(([key, at]) => (
              <Fragment key={key}>
                <dt>{t(key)}</dt>
                <dd>{dateTime(at)}</dd>
              </Fragment>
            ))}
          {c.cancelReason && (
            <>
              <dt>{t('cancelReason')}</dt>
              <dd className="pre">{c.cancelReason}</dd>
            </>
          )}
          {c.notes && (
            <>
              <dt>{tc('notes')}</dt>
              <dd className="pre">{c.notes}</dd>
            </>
          )}
          <dt>{t('createdBy')}</dt>
          <dd>{c.createdByName}</dd>
        </dl>
      )}

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('shipmentsSection')}</h2>
            <p className="muted">{t('shipmentsHint')}</p>
          </div>
        </div>
        {c.shipments.length === 0 ? (
          <p className="empty">{t('noShipments')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('shipment')}</th>
                  <th>{t('customer')}</th>
                  <th>{t('destination')}</th>
                  <th>{t('packages')}</th>
                  <th>{t('weightKg')}</th>
                  <th>{t('volumeCbm')}</th>
                  <th>{t('basisValue')}</th>
                  {c.showsCost && <th>{t('allocatedUsd')}</th>}
                  <th>{tc('status')}</th>
                  {a.canEditShipments && <th />}
                </tr>
              </thead>
              <tbody>
                {c.shipments.map((s) => (
                  <tr key={s.shipmentId}>
                    <td dir="ltr">
                      {can(me, 'shipments:view') ? (
                        <Link href={`/shipments/${s.shipmentId}`}>{s.shipmentNumber}</Link>
                      ) : (
                        s.shipmentNumber
                      )}
                    </td>
                    <td>{s.customerName}</td>
                    <td>{locationName(s.destinationLocationId)}</td>
                    <td>{s.packages}</td>
                    <td dir="ltr">{s.weightKg ?? '—'}</td>
                    <td dir="ltr">{s.volumeCbm ?? '—'}</td>
                    <td dir="ltr">{s.basisValue ?? '—'}</td>
                    {c.showsCost && (
                      <td>
                        {s.allocatedUsd !== null ? (
                          <Money value={s.allocatedUsd} currency="USD" />
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                    <td>
                      <StatusBadge kind="shipment" status={s.status} />
                    </td>
                    {a.canEditShipments && (
                      <td>
                        <button
                          type="button"
                          className="button small"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () =>
                                api<ConsolidationDto>(
                                  `/consolidations/${id}/shipments/${s.shipmentId}`,
                                  { method: 'DELETE' },
                                ),
                              tc('saved'),
                            )
                          }
                        >
                          {tc('remove')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {a.canEditShipments && (
          <div className="panel-body">
            <LclShipmentPicker
              exclude={c.shipments.map((s) => s.shipmentId)}
              disabled={busy}
              onError={(e) => setNotice({ ok: false, text: failure(e) })}
              onPick={(s) =>
                void run(
                  () =>
                    api<ConsolidationDto>(`/consolidations/${id}/shipments`, {
                      method: 'POST',
                      body: { shipmentId: s.id },
                    }),
                  tc('saved'),
                )
              }
            />
          </div>
        )}
      </div>

      {c.showsCost && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('costsSection')}</h2>
              <p className="muted">{t('costsHint')}</p>
            </div>
          </div>
          {c.costs.length === 0 ? (
            <p className="empty">{t('noCosts')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('bill')}</th>
                    <th>{t('supplier')}</th>
                    <th>{t('chargeType')}</th>
                    <th>{t('amount')}</th>
                    <th>{t('allocationEntry')}</th>
                  </tr>
                </thead>
                <tbody>
                  {c.costs.map((cost) => (
                    <tr key={`${cost.billId}-${cost.lineNo}`}>
                      <td dir="ltr">
                        {can(me, 'suppliers:view') ? (
                          <Link href={`/supplier-bills/${cost.billId}`}>{cost.billNumber}</Link>
                        ) : (
                          cost.billNumber
                        )}
                      </td>
                      <td>
                        {cost.supplierName}
                        {cost.description && <div className="muted">{cost.description}</div>}
                      </td>
                      <td dir="ltr">{cost.chargeTypeCode}</td>
                      <td>
                        <Money value={cost.amount} currency={cost.currency} />
                      </td>
                      <td>
                        {cost.allocationEntryId && cost.allocationEntryNumber ? (
                          journalLink(cost.allocationEntryId, cost.allocationEntryNumber)
                        ) : (
                          <span className="muted">{t('allocationPending')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {c.clearingBalanceUsd !== null && (
            <p className="panel-body">
              {t('clearingBalance')}: <Money value={c.clearingBalanceUsd} currency="USD" />
            </p>
          )}
        </div>
      )}
    </section>
  );
}
