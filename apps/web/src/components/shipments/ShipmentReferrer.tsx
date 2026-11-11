'use client';

import type { ShipmentDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useFailureText } from '../commercial/Notice';
import { PartnerName, PartnerSelect } from '../partners/PartnerSelect';
import { useMe } from '../StaffShell';

/**
 * Plan 18, 4: who earns the referral commission on the shipment and why, and the broker who
 * brought it in person. Staff who may edit the shipment correct that broker, with a reason; the
 * API decides who is paid.
 */
export function ShipmentReferrer({
  shipment,
  canEdit,
  onChanged,
}: {
  shipment: ShipmentDto;
  canEdit: boolean;
  onChanged: (shipment: ShipmentDto) => void;
}) {
  const t = useTranslations('Shipments');
  const tc = useTranslations('Common');
  const me = useMe();
  const failure = useFailureText();
  const { referral } = shipment;
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(referral.broughtBy?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = field(new FormData(e.currentTarget), 'reason').trim();
    setBusy(true);
    setError(null);
    try {
      onChanged(
        await api<ShipmentDto>(`/shipments/${shipment.id}/referrer`, {
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
        <PartnerName partner={referral.referrer} />
        {referral.reason && <> · {t(`referrerReason_${referral.reason}`)}</>}
        {referral.broughtBy && referral.broughtBy.id !== referral.referrer?.id && (
          <>
            {' · '}
            {t('broughtBy')}: <PartnerName partner={referral.broughtBy} />
          </>
        )}
        {canEdit && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => {
                setChoice(referral.broughtBy?.id ?? '');
                setEditing(true);
              }}
            >
              {t('changeBroughtBy')}
            </button>
          </>
        )}
      </>
    );
  }
  return (
    <form className="stack" autoComplete="off" onSubmit={(e) => void save(e)}>
      <label className="field">
        {t('broughtBy')}
        <PartnerSelect
          kind="REFERRER"
          branchIds={me.branches.map((b) => b.id)}
          held={referral.broughtBy}
          value={choice}
          onChange={setChoice}
        />
      </label>
      <label className="field">
        {t('broughtByReason')}
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
