'use client';

import {
  WINDOW_DESK_FILTERS,
  type WindowDeskBookingDto,
  type WindowDeskFilter,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, useFailureText } from '../commercial/Notice';
import { PrintLink } from '../print/PrintLink';
import { can, useMe } from '../StaffShell';
import { WindowPaymentForm } from './WindowPaymentForm';
import { WindowReceiptForm } from './WindowReceiptForm';

/**
 * Plan 13 section 2: «طلبات الاستلام», a partner outlet's list of the confirmed bookings whose
 * goods are handed over at its windows: expected first, then received. The window receives the
 * goods here (plan 13 section 3) and prints the goods receipt.
 */
export function WindowDesk() {
  const t = useTranslations('WindowDesk');
  const tc = useTranslations('Common');
  const me = useMe();
  const failure = useFailureText();
  const [filter, setFilter] = useState<WindowDeskFilter>('expected');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<WindowDeskBookingDto[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // The refusal itself; its text is made when shown, so loading depends on nothing that re-renders.
  const [error, setError] = useState<unknown>(null);

  // Only the answer sets state, so the first load can run from an effect.
  const fetchRows = useCallback((status: WindowDeskFilter, search: string) => {
    const query = new URLSearchParams({ status });
    if (search.trim()) query.set('q', search.trim());
    api<WindowDeskBookingDto[]>(`/window-desk/expected?${query.toString()}`)
      .then((list) => {
        setError(null);
        setRows(list);
      })
      .catch((err: unknown) => {
        setRows([]);
        setError(err);
      });
  }, []);
  function load(status: WindowDeskFilter, search: string) {
    setRows(null);
    fetchRows(status, search);
  }
  const allowed = me.windowDeskEnabled && can(me, 'window_desk:view');
  useEffect(() => {
    if (allowed) fetchRows('expected', '');
  }, [allowed, fetchRows]);

  if (!allowed) return <p className="error">{tc('noAccess')}</p>;
  return (
    <section className="stack">
      <div>
        <h1>{t('title')}</h1>
        <p className="muted">{t('hint')}</p>
      </div>
      <Notice notice={error === null ? null : { ok: false, text: failure(error) }} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          load(filter, q);
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
          value={filter}
          aria-label={t('filter')}
          onChange={(e) => {
            const f = e.target.value as WindowDeskFilter;
            setFilter(f);
            load(f, q);
          }}
        >
          {WINDOW_DESK_FILTERS.map((f) => (
            <option key={f} value={f}>
              {t(`filter_${f}`)}
            </option>
          ))}
        </select>
        <button type="submit">{tc('search')}</button>
      </form>
      {rows === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : rows.length === 0 ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <div className="stack">
          {rows.map((r) => (
            <WindowDeskCard
              key={r.bookingId}
              row={r}
              open={open === r.bookingId}
              onToggle={() => setOpen(open === r.bookingId ? null : r.bookingId)}
              onChanged={(next) =>
                setRows((list) =>
                  list ? list.map((x) => (x.bookingId === next.bookingId ? next : x)) : list,
                )
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One booking: who brings what, what they owe, and what is left to do; details, the goods
 * receipts made at the window and the form to receive the goods on demand.
 */
export function WindowDeskCard({
  row: r,
  open,
  onToggle,
  onChanged,
}: {
  row: WindowDeskBookingDto;
  open: boolean;
  onToggle: () => void;
  onChanged: (row: WindowDeskBookingDto) => void;
}) {
  const t = useTranslations('WindowDesk');
  const me = useMe();
  const [receiving, setReceiving] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const mayCollect =
    me.windowCollectEnabled &&
    can(me, 'window_desk:update') &&
    r.invoice !== null &&
    r.todo.includes('collect');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const pick = (v: { ar: string; en: string }) => (locale === 'ar' ? v.ar : v.en);
  return (
    <article className="card stack">
      <div className="row">
        <h2 dir="ltr">{r.bookingNumber}</h2>
        <span className="muted">
          {r.todo.length === 0 ? t('todo_none') : r.todo.map((x) => t(`todo_${x}`)).join(' · ')}
        </span>
      </div>
      <dl className="details">
        <dt>{t('sender')}</dt>
        <dd>
          {r.sender.name} {r.sender.phone && <span dir="ltr">{r.sender.phone}</span>}
        </dd>
        <dt>{t('route')}</dt>
        <dd>
          {locationName(r.originLocationId)} → {locationName(r.destinationLocationId)}
        </dd>
        <dt>{t('amount')}</dt>
        <dd>
          {r.invoice ? (
            <span dir="ltr">
              {r.invoice.balance} / {r.invoice.total} {r.invoice.currency}
            </span>
          ) : (
            t('noInvoice')
          )}
        </dd>
      </dl>
      <div className="actions">
        <button type="button" onClick={onToggle} aria-expanded={open}>
          {open ? t('hide') : t('show')}
        </button>
        {open && (
          <button type="button" onClick={() => window.print()}>
            {t('print')}
          </button>
        )}
        {r.todo.includes('receive') && can(me, 'window_desk:create') && (
          <button
            type="button"
            className="primary"
            aria-expanded={receiving}
            onClick={() => setReceiving(!receiving)}
          >
            {t('receive')}
          </button>
        )}
        {mayCollect && (
          <button
            type="button"
            className="primary"
            aria-expanded={collecting}
            onClick={() => setCollecting(!collecting)}
          >
            {t('collect')}
          </button>
        )}
      </div>
      {receiving && r.todo.includes('receive') && (
        <WindowReceiptForm
          row={r}
          onReceived={(next) => {
            setReceiving(false);
            onChanged(next);
          }}
        />
      )}
      {collecting && mayCollect && (
        <WindowPaymentForm
          row={r}
          onPaid={(next) => {
            setCollecting(false);
            onChanged(next);
          }}
        />
      )}
      {r.payments.length > 0 && (
        <ul className="stack">
          {r.payments.map((p) => (
            <li key={p.id} className="row">
              <span>
                {t('paymentLine', { number: p.number, amount: p.amount, currency: p.currency })}{' '}
                <span dir="ltr">{p.receiptDate}</span>
              </span>
              <PrintLink
                small
                href={`/window-desk/${r.bookingId}/payments/${p.id}`}
                label={t('printReceipt')}
              />
            </li>
          ))}
        </ul>
      )}
      {r.receipts.length > 0 && (
        <ul className="stack">
          {r.receipts.map((m) => (
            <li key={m.id} className="row">
              <span>
                {t('receiptLine', { number: m.number, packages: m.packages })}{' '}
                <span dir="ltr">{m.occurredAt.slice(0, 10)}</span>
              </span>
              <PrintLink
                small
                href={`/window-desk/${r.bookingId}/receipts/${m.id}`}
                label={t('printGrn')}
              />
            </li>
          ))}
          {/* Plan 13-5: the waybill for the parcel, handed over as soon as it is received. */}
          <li className="row">
            <PrintLink
              small
              href={`/window-desk/${r.bookingId}/waybill`}
              label={t('printWaybill')}
            />
          </li>
        </ul>
      )}
      {open && (
        <dl className="details">
          <dt>{t('confirmedAt')}</dt>
          <dd dir="ltr">{r.confirmedAt?.slice(0, 10) ?? '—'}</dd>
          <dt>{t('receiver')}</dt>
          <dd>
            {r.receiver ? (
              <>
                {r.receiver.name} {r.receiver.phone && <span dir="ltr">{r.receiver.phone}</span>}
                {r.receiver.city && ` · ${r.receiver.city}`}
              </>
            ) : (
              '—'
            )}
          </dd>
          <dt>{t('window')}</dt>
          <dd>
            {pick(r.window.name)} ({r.window.code})
            {r.window.outletName && ` · ${r.window.outletName}`}
          </dd>
          <dt>{t('mode')}</dt>
          <dd>{te(`mode_${r.mode}`)}</dd>
          <dt>{t('items')}</dt>
          <dd>
            <ul>
              {r.items.map((i) => (
                <li key={i.lineNo}>
                  {i.quantity} × {te(`cargo_${i.cargoType}`)}
                  {i.priceCategoryCode && ` (${i.priceCategoryCode})`}
                  {i.description && ` · ${i.description}`}
                </li>
              ))}
            </ul>
          </dd>
          {r.invoice && (
            <>
              <dt>{t('invoice')}</dt>
              <dd>
                <span dir="ltr">{r.invoice.number ?? '—'}</span> ·{' '}
                {t(`invoice_${r.invoice.status}`)}
              </dd>
            </>
          )}
        </dl>
      )}
    </article>
  );
}
