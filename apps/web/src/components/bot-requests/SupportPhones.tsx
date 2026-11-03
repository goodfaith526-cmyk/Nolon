'use client';

import type { BranchSupportPhoneDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';

/**
 * Each branch's customer service number (plan 09 amendment 4): the shipping bot gives it to the
 * customers of a key's branches. Empty: the bot shows none for that branch.
 */
export function SupportPhones({ editable }: { editable: boolean }) {
  const t = useTranslations('BotRequests');
  const tc = useTranslations('Common');
  const localName = useLocalName();
  const failure = useFailureText();
  const [rows, setRows] = useState<BranchSupportPhoneDto[] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<BranchSupportPhoneDto[]>('/master-data/branches/support-phones')
      .then(setRows)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [failure]);

  async function save(event: FormEvent<HTMLFormElement>, branchId: string) {
    event.preventDefault();
    const phone = field(new FormData(event.currentTarget), 'phone').trim() || null;
    setBusy(true);
    setNotice(null);
    try {
      setRows(
        await api<BranchSupportPhoneDto[]>(`/master-data/branches/${branchId}/support-phone`, {
          method: 'PUT',
          body: { phone },
        }),
      );
      setNotice({ ok: true, text: tc('saved') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2>{t('supportPhonesTitle')}</h2>
      <p className="muted">{t('supportPhonesHint')}</p>
      {notice && <Notice notice={notice} />}
      {rows === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : (
        rows.map((b) =>
          editable ? (
            <form key={b.branchId} className="line" onSubmit={(e) => void save(e, b.branchId)}>
              <label className="field grow">
                <span>
                  {localName(b)} ({b.code})
                </span>
                <input
                  // Read again after a save, so the field shows what the API kept.
                  key={b.phone ?? ''}
                  name="phone"
                  dir="ltr"
                  inputMode="tel"
                  pattern="\+[1-9][0-9]{7,14}"
                  placeholder="+249912345678"
                  defaultValue={b.phone ?? ''}
                />
              </label>
              <button type="submit" disabled={busy}>
                {tc('save')}
              </button>
            </form>
          ) : (
            <p key={b.branchId}>
              {localName(b)} ({b.code}): <span dir="ltr">{b.phone ?? '—'}</span>
            </p>
          ),
        )
      )}
    </div>
  );
}
