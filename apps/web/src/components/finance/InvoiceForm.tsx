'use client';

import type { CustomerInvoiceDto, CustomerInvoiceInput } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN, FX_RATE_PATTERN } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useRecord } from './common';

interface LineState {
  key: number;
  chargeTypeCode: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

let nextKey = 1;
const emptyLine = (chargeTypeCode: string): LineState => ({
  key: nextKey++,
  chargeTypeCode,
  description: '',
  quantity: '1',
  unitPrice: '',
});

/** Loads a draft invoice for editing. */
export function InvoiceEdit({ id }: { id: string }) {
  const t = useTranslations('Invoices');
  const tc = useTranslations('Common');
  const { record, notice } = useRecord<CustomerInvoiceDto>(`/customer-invoices/${id}`);
  if (notice) return <Notice notice={notice} />;
  if (!record) return <p className="muted">{tc('loading')}</p>;
  if (!record.actions.canEdit) {
    return (
      <section className="stack">
        <p className="error">{t('notEditable')}</p>
        <div>
          <Link href={`/invoices/${id}`} className="button">
            {tc('back')}
          </Link>
        </div>
      </section>
    );
  }
  return <InvoiceForm invoice={record} />;
}

/** Edit of a draft invoice. Line totals and the invoice total are computed by the API. */
function InvoiceForm({ invoice }: { invoice: CustomerInvoiceDto }) {
  const t = useTranslations('Invoices');
  const tc = useTranslations('Common');
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const router = useRouter();
  const [currency, setCurrency] = useState(invoice.currency);
  const [lines, setLines] = useState<LineState[]>(() =>
    invoice.lines.length === 0
      ? [emptyLine('')]
      : invoice.lines.map((l) => ({
          key: nextKey++,
          chargeTypeCode: l.chargeTypeCode,
          description: l.description ?? '',
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const chargeTypes = (master?.chargeTypes ?? []).filter(
    (c) => c.isActive || lines.some((l) => l.chargeTypeCode === c.code),
  );
  const defaultCharge = chargeTypes[0]?.code ?? '';

  function updateLine(key: number, patch: Partial<LineState>) {
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fxRate = field(form, 'fxRate').trim();
    const body: CustomerInvoiceInput = {
      currency,
      fxRate: currency === 'USD' || fxRate === '' ? null : fxRate,
      invoiceDate: field(form, 'invoiceDate'),
      dueDate: field(form, 'dueDate'),
      notes: field(form, 'notes').trim() || null,
      lines: lines.map((l) => ({
        chargeTypeCode: l.chargeTypeCode || defaultCharge,
        description: l.description.trim() || null,
        quantity: l.quantity.trim(),
        unitPrice: l.unitPrice.trim(),
      })),
    };
    setBusy(true);
    setNotice(null);
    try {
      await api<CustomerInvoiceDto>(`/customer-invoices/${invoice.id}`, { method: 'PATCH', body });
      router.push(`/invoices/${invoice.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  if (!master) return <p className="muted">{tc('loading')}</p>;

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <h1>
        {invoice.number ? (
          <>
            {t('editTitle')} <span dir="ltr">{invoice.number}</span>
          </>
        ) : (
          t('editDraftTitle')
        )}
      </h1>
      <p className="muted">
        {invoice.customerName} · <span dir="ltr">{invoice.shipmentNumber}</span>
      </p>
      <Notice notice={notice} />
      <div className="grid">
        <label className="field">
          {t('currency')}
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {master.currencies
              .filter((c) => c.isActive || c.code === invoice.currency)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {name(c)}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          {t('fxRateOptional')}
          <input
            name="fxRate"
            inputMode="decimal"
            dir="ltr"
            pattern={FX_RATE_PATTERN}
            disabled={currency === 'USD'}
            defaultValue={invoice.currency === 'USD' ? '' : invoice.fxRate}
          />
        </label>
        <label className="field">
          {t('invoiceDate')}
          <input name="invoiceDate" type="date" required defaultValue={invoice.invoiceDate} />
        </label>
        <label className="field">
          {t('dueDate')}
          <input name="dueDate" type="date" required defaultValue={invoice.dueDate} />
        </label>
      </div>
      <p className="muted">{t('fxRateHint', { currency })}</p>

      <fieldset className="stack">
        <legend>{t('lines')}</legend>
        {lines.map((l, index) => (
          <div key={l.key} className="line">
            <span className="muted">{index + 1}</span>
            <label className="field">
              {t('chargeType')}
              <select
                value={l.chargeTypeCode || defaultCharge}
                onChange={(e) => updateLine(l.key, { chargeTypeCode: e.target.value })}
              >
                {chargeTypes.map((c) => (
                  <option key={c.code} value={c.code}>
                    {name(c)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field grow">
              {t('description')}
              <input
                value={l.description}
                maxLength={500}
                onChange={(e) => updateLine(l.key, { description: e.target.value })}
              />
            </label>
            <label className="field">
              {t('quantity')}
              <input
                required
                inputMode="decimal"
                dir="ltr"
                pattern={AMOUNT_PATTERN}
                value={l.quantity}
                onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
              />
            </label>
            <label className="field">
              {t('unitPrice')}
              <input
                required
                inputMode="decimal"
                dir="ltr"
                pattern={AMOUNT_PATTERN}
                value={l.unitPrice}
                onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })}
              />
            </label>
            {lines.length > 1 && (
              <button
                type="button"
                onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}
              >
                {tc('remove')}
              </button>
            )}
          </div>
        ))}
        <div>
          <button
            type="button"
            onClick={() => setLines((all) => [...all, emptyLine(defaultCharge)])}
          >
            {t('addLine')}
          </button>
        </div>
        <p className="muted">{t('totalsHint')}</p>
      </fieldset>

      <label className="field">
        {tc('notes')}
        <textarea name="notes" maxLength={2000} defaultValue={invoice.notes ?? ''} />
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {tc('save')}
        </button>
        <button type="button" onClick={() => router.back()}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
