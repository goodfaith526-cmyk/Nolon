'use client';

import {
  CUSTOMS_STATUSES,
  type CustomsClearanceRequest,
  type CustomsFeeRequest,
  type CustomsStatus,
  type ShipmentCustomsDto,
  type ShipmentDto,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money } from '../finance/common';
import { StatusBadge } from '../StatusBadge';

/**
 * The shipment's customs file: clearance status, declaration number, broker, dates, notes and
 * fees. Fees are recorded only (no journal entry). Saving the file moves the shipment to
 * customs in progress or cleared when the state machine allows it (the API does this). Only the
 * file sets those statuses (functional review Z1): there are no manual buttons for them.
 */
export function ShipmentCustoms({
  shipment,
  onShipmentChange,
}: {
  shipment: ShipmentDto;
  onShipmentChange: (s: ShipmentDto) => void;
}) {
  const t = useTranslations('Customs');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const master = useMasterData();
  const failure = useFailureText();
  const [data, setData] = useState<ShipmentCustomsDto | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const shipmentId = shipment.id;

  const load = useCallback(() => {
    api<ShipmentCustomsDto>(`/shipments/${shipmentId}/customs`)
      .then(setData)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [shipmentId, failure]);

  useEffect(load, [load]);

  async function run<T>(action: () => Promise<T>, success: string): Promise<T | null> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      setNotice({ ok: true, text: success });
      return result;
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (name: string) => field(f, name).trim() || null;
    const body: CustomsClearanceRequest = {
      status: field(f, 'status') as CustomsStatus,
      declarationNumber: text('declarationNumber'),
      brokerName: text('brokerName'),
      submittedOn: text('submittedOn'),
      clearedOn: text('clearedOn'),
      note: text('note'),
    };
    const saved = await run(
      () => api<ShipmentCustomsDto>(`/shipments/${shipmentId}/customs`, { method: 'PUT', body }),
      tc('saved'),
    );
    if (saved) {
      setData(saved);
      setEditing(false);
      // Saving the file may have moved the shipment (functional review D1): show its status now.
      try {
        const now = await api<ShipmentDto>(`/shipments/${shipmentId}`);
        if (now.status !== shipment.status) {
          setNotice({
            ok: true,
            text: t('savedAndMoved', { status: te(`shipment_${now.status}`) }),
          });
        }
        onShipmentChange(now);
      } catch {
        // The file is saved; the shipment page shows its status when it next loads.
      }
    }
  }

  async function onAddFee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const f = new FormData(element);
    const body: CustomsFeeRequest = {
      description: field(f, 'description').trim(),
      amount: field(f, 'amount').trim(),
      currency: field(f, 'currency'),
      note: field(f, 'note').trim() || null,
    };
    const saved = await run(
      () =>
        api<ShipmentCustomsDto>(`/shipments/${shipmentId}/customs/fees`, {
          method: 'POST',
          body,
        }),
      t('feeAdded'),
    );
    if (saved) {
      setData(saved);
      element.reset();
    }
  }

  async function removeFee(feeId: string) {
    const saved = await run(
      () =>
        api<ShipmentCustomsDto>(`/shipments/${shipmentId}/customs/fees/${feeId}`, {
          method: 'DELETE',
        }),
      t('feeRemoved'),
    );
    if (saved) setData(saved);
  }

  const clearance = data?.clearance ?? null;
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const currencies = (master?.currencies ?? []).filter((c) => c.isActive);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('section')}</h2>
        <div className="actions">
          {clearance && <StatusBadge kind="customs" status={clearance.status} />}
          {data?.actions.canEdit && !editing && (
            <button type="button" onClick={() => setEditing(true)}>
              {clearance ? tc('edit') : t('open')}
            </button>
          )}
        </div>
      </div>
      {notice && (
        <div className="panel-body">
          <Notice notice={notice} />
        </div>
      )}
      {data === null ? (
        notice ? null : (
          <p className="empty">{tc('loading')}</p>
        )
      ) : editing ? (
        <form className="panel-body stack" onSubmit={(e) => void onSave(e)}>
          <div className="grid">
            <label className="field">
              <span>{t('status')}</span>
              <select name="status" required defaultValue={clearance?.status ?? 'PENDING'}>
                {CUSTOMS_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {te(`customs_${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('declarationNumber')}</span>
              <input
                name="declarationNumber"
                maxLength={50}
                dir="ltr"
                defaultValue={clearance?.declarationNumber ?? ''}
              />
            </label>
            <label className="field">
              <span>{t('brokerName')}</span>
              <input name="brokerName" maxLength={200} defaultValue={clearance?.brokerName ?? ''} />
            </label>
            <label className="field">
              <span>{t('submittedOn')}</span>
              <input name="submittedOn" type="date" defaultValue={clearance?.submittedOn ?? ''} />
            </label>
            <label className="field">
              <span>{t('clearedOn')}</span>
              <input name="clearedOn" type="date" defaultValue={clearance?.clearedOn ?? ''} />
            </label>
          </div>
          <label className="field">
            <span>{t('note')}</span>
            <textarea name="note" maxLength={2000} defaultValue={clearance?.note ?? ''} />
          </label>
          <p className="muted">{t('clearedHint')}</p>
          <p className="muted">{t('movesShipmentHint')}</p>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              {tc('back')}
            </button>
          </div>
        </form>
      ) : clearance ? (
        <dl className="details flat">
          <dt>{t('status')}</dt>
          <dd>{te(`customs_${clearance.status}`)}</dd>
          <dt>{t('declarationNumber')}</dt>
          <dd dir="ltr">{clearance.declarationNumber ?? '—'}</dd>
          <dt>{t('brokerName')}</dt>
          <dd>{clearance.brokerName ?? '—'}</dd>
          <dt>{t('submittedOn')}</dt>
          <dd dir="ltr">{clearance.submittedOn ?? '—'}</dd>
          <dt>{t('clearedOn')}</dt>
          <dd dir="ltr">{clearance.clearedOn ?? '—'}</dd>
          {clearance.note && (
            <>
              <dt>{t('note')}</dt>
              <dd className="pre">{clearance.note}</dd>
            </>
          )}
          <dt>{t('updated')}</dt>
          <dd>
            <bdi>{clearance.updatedByName}</bdi> ·{' '}
            <bdi>{dateTime.format(new Date(clearance.updatedAt))}</bdi>
          </dd>
        </dl>
      ) : (
        <p className="empty">{t('none')}</p>
      )}
      <p className="muted panel-body">{t('documentsHint')}</p>

      {data && (
        <>
          <h3 className="panel-body">{t('fees')}</h3>
          {data.actions.canAddFee && (
            <form className="line panel-body" onSubmit={(e) => void onAddFee(e)}>
              <label className="field grow">
                <span>{t('feeDescription')}</span>
                <input name="description" required maxLength={200} />
              </label>
              <label className="field">
                <span>{t('amount')}</span>
                <input
                  name="amount"
                  required
                  inputMode="decimal"
                  dir="ltr"
                  className="amount-input"
                  pattern={AMOUNT_PATTERN}
                />
              </label>
              <label className="field">
                <span>{t('currency')}</span>
                <select name="currency" required>
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field grow">
                <span>{t('note')}</span>
                <input name="note" maxLength={1000} />
              </label>
              <button type="submit" disabled={busy}>
                {t('addFee')}
              </button>
            </form>
          )}
          {data.fees.length === 0 ? (
            <p className="empty">{t('noFees')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('feeDescription')}</th>
                  <th>{t('amount')}</th>
                  <th>{t('recordedBy')}</th>
                  {data.actions.canRemoveFee && <th />}
                </tr>
              </thead>
              <tbody>
                {data.fees.map((f) => (
                  <tr key={f.id}>
                    <td>
                      {f.description}
                      {f.note && <div className="muted">{f.note}</div>}
                    </td>
                    <td dir="ltr">
                      <Money value={f.amount} currency={f.currency} />
                    </td>
                    <td>
                      {f.createdByName}
                      <div className="muted">{dateTime.format(new Date(f.createdAt))}</div>
                    </td>
                    {data.actions.canRemoveFee && (
                      <td>
                        <button type="button" disabled={busy} onClick={() => void removeFee(f.id)}>
                          {tc('remove')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {data.totals.map((total) => (
                  <tr key={total.currency}>
                    <th>{t('total')}</th>
                    <th dir="ltr">
                      <Money value={total.amount} currency={total.currency} />
                    </th>
                    <th />
                    {data.actions.canRemoveFee && <th />}
                  </tr>
                ))}
              </tfoot>
            </table>
          )}
          <p className="muted panel-body">{t('feesHint')}</p>
        </>
      )}
    </div>
  );
}
