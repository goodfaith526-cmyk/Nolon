'use client';

import type { CustomerChatWarningsDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from './Notice';

/**
 * Owner, 2026-11-07: what a chat brought that the customer file did not take (another name, a
 * phone another file has, another address or city). Staff read it, edit the file by hand if they
 * agree, and mark it seen. The API decides what is a warning; this only shows it.
 */
export function CustomerChatWarnings({
  customerId,
  canEdit,
}: {
  customerId: string;
  canEdit: boolean;
}) {
  const t = useTranslations('Customers');
  const failure = useFailureText();
  const [data, setData] = useState<CustomerChatWarningsDto | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    api<CustomerChatWarningsDto>(`/customer-profiles/customer/${customerId}/warnings`)
      .then(setData)
      // The chat profiles may be switched off: then there is nothing to show.
      .catch(() => setData(null));
  }, [customerId]);
  useEffect(load, [load]);

  if (!data || data.warnings.length === 0) return <Notice notice={notice} />;

  async function seen() {
    setNotice(null);
    try {
      await api(`/customer-profiles/customer/${customerId}/warnings/seen`, {
        method: 'POST',
        body: { expectedVersion: data?.profileVersion },
      });
      setNotice({ ok: true, text: t('chatWarningsSeen') });
      load();
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  return (
    <div className="card stack">
      <h2>{t('chatWarnings')}</h2>
      <p className="muted">{t('chatWarningsHelp')}</p>
      <ul>
        {data.warnings.map((w) => (
          <li key={`${w.field}:${w.value}`}>
            {t(`chatWarning_${w.field}`)}:{' '}
            <bdi dir={w.field === 'phone' ? 'ltr' : undefined}>{w.value}</bdi>
            {w.heldBy.length > 0 ? (
              <span className="muted">
                {' '}
                {t('chatWarningHeldBy', { numbers: w.heldBy.join('، ') })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className="actions">
          <button type="button" onClick={() => void seen()}>
            {t('chatWarningsMarkSeen')}
          </button>
        </div>
      ) : null}
      <Notice notice={notice} />
    </div>
  );
}
