'use client';

import type { CustomerDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { PartnerName, PartnerSelect } from '../partners/PartnerSelect';
import { useMe } from '../StaffShell';
import { useFailureText } from './Notice';

/**
 * Plan 18, 3: the referral broker who registered the customer. Staff who may edit customers set,
 * change or clear him, always with a reason; the API decides and records it.
 */
export function CustomerReferrer({
  customer,
  canEdit,
  onChanged,
}: {
  customer: CustomerDto;
  canEdit: boolean;
  onChanged: (customer: CustomerDto) => void;
}) {
  const t = useTranslations('Customers');
  const tc = useTranslations('Common');
  const me = useMe();
  const failure = useFailureText();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(customer.referredBy?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = field(new FormData(e.currentTarget), 'reason').trim();
    setBusy(true);
    setError(null);
    try {
      onChanged(
        await api<CustomerDto>(`/customers/${customer.id}/referrer`, {
          method: 'POST',
          body: { partnerId: choice || null, reason },
        }),
      );
      setEditing(false);
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <>
        <PartnerName partner={customer.referredBy} />
        {canEdit && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => {
                setChoice(customer.referredBy?.id ?? '');
                setEditing(true);
              }}
            >
              {t('changeReferrer')}
            </button>
          </>
        )}
      </>
    );
  }
  return (
    <form className="stack" autoComplete="off" onSubmit={(e) => void save(e)}>
      <label className="field">
        {t('referredBy')}
        <PartnerSelect
          kind="REFERRER"
          branchIds={me.branches.map((b) => b.id)}
          held={customer.referredBy}
          value={choice}
          onChange={setChoice}
        />
      </label>
      <label className="field">
        {t('referrerReason')}
        <textarea name="reason" required maxLength={500} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {tc('save')}
        </button>
        <button type="button" onClick={() => setEditing(false)}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
