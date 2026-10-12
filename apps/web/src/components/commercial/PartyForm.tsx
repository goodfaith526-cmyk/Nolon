'use client';

import type { CustomerPartyAddedDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { Notice, type NoticeState, useFailureText } from './Notice';

/**
 * Adds a party (shipper, consignee, notify party) to a customer; `onSaved` gets the customer and
 * the id of the party this save created.
 */
export function PartyForm({
  customerId,
  initialName = '',
  title,
  onSaved,
  onCancel,
}: {
  customerId: string;
  initialName?: string;
  title?: string;
  onSaved: (customer: CustomerPartyAddedDto) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('Customers');
  const tc = useTranslations('Common');
  const failure = useFailureText();
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setNotice(null);
    try {
      onSaved(
        await api<CustomerPartyAddedDto>(`/customers/${customerId}/parties`, {
          method: 'POST',
          body: {
            name: field(form, 'name'),
            companyName: field(form, 'companyName') || null,
            phone: field(form, 'phone').replace(/\s/g, '') || null,
            email: field(form, 'email') || null,
            city: field(form, 'city') || null,
            address: field(form, 'address') || null,
          },
        }),
      );
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      {title && <h2>{title}</h2>}
      <Notice notice={notice} />
      <div className="grid">
        <label className="field">
          {t('name')}
          <input name="name" required maxLength={200} defaultValue={initialName} />
        </label>
        <label className="field">
          {t('companyName')}
          <input name="companyName" maxLength={200} />
        </label>
        <label className="field">
          {t('phone')}
          <input name="phone" dir="ltr" placeholder="+249912345678" />
        </label>
        <label className="field">
          {t('email')}
          <input name="email" type="email" dir="ltr" />
        </label>
        <label className="field">
          {t('city')}
          <input name="city" maxLength={100} />
        </label>
        <label className="field">
          {t('address')}
          <input name="address" maxLength={500} />
        </label>
      </div>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {tc('save')}
        </button>
        <button type="button" onClick={onCancel}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
