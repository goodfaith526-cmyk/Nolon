'use client';

import type { WindowDeskBookingDto, WindowDeskPaymentRequest } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';

/** Up to 4 decimals, as the API takes an amount (the currency's own places are checked there). */
const AMOUNT_PATTERN = '\\d{1,14}(\\.\\d{1,4})?';

/**
 * Plan 13 section 4: the window takes the customer's money, in the invoice's currency, at most
 * what is owed. The API approves the pro forma invoice and posts the receipt; the request id is
 * kept until it succeeds, so sending again after a lost answer never posts twice.
 */
export function WindowPaymentForm({
  row,
  onPaid,
}: {
  row: WindowDeskBookingDto;
  onPaid: (row: WindowDeskBookingDto) => void;
}) {
  const t = useTranslations('WindowDesk');
  const failure = useFailureText();
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const invoice = row.invoice;
  if (!invoice) return null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!invoice) return;
    const f = new FormData(event.currentTarget);
    const body: WindowDeskPaymentRequest = {
      requestId,
      amount: field(f, 'amount').trim(),
      currency: invoice.currency,
      reference: field(f, 'reference').trim() || null,
    };
    setBusy(true);
    setNotice(null);
    try {
      onPaid(
        await api<WindowDeskBookingDto>(`/window-desk/bookings/${row.bookingId}/payment`, {
          method: 'POST',
          body,
        }),
      );
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void onSubmit(e)}>
      <h3>{t('collectTitle')}</h3>
      {invoice.status === 'DRAFT' && <p className="muted">{t('collectApproves')}</p>}
      <Notice notice={notice} />
      <div className="form-grid">
        <label className="field">
          <span>{t('collectAmount', { currency: invoice.currency })}</span>
          <input
            name="amount"
            required
            inputMode="decimal"
            dir="ltr"
            pattern={AMOUNT_PATTERN}
            defaultValue={invoice.balance}
          />
        </label>
        <label className="field">
          <span>{t('collectReference')}</span>
          <input name="reference" maxLength={100} />
        </label>
      </div>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {t('collectSubmit')}
        </button>
      </div>
    </form>
  );
}
