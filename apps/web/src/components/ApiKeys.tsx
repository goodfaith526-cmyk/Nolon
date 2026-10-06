'use client';

import type { ApiClientCreatedDto, ApiClientDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from './commercial/Notice';
import { useRecord } from './finance/common';
import { can, useMe } from './StaffShell';
import { useDateTime } from './transport/common';

/** Customer Service API keys (for the AI agent later): made, listed and revoked here. */
export function ApiKeys() {
  const t = useTranslations('ApiKeys');
  const tc = useTranslations('Common');
  const me = useMe();
  const localName = useLocalName();
  const dateTime = useDateTime();
  const failure = useFailureText();
  const {
    record: clients,
    notice: loadNotice,
    setRecord,
  } = useRecord<ApiClientDto[]>('/api-clients');
  const [created, setCreated] = useState<ApiClientCreatedDto | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  if (!can(me, 'users:view')) return <p className="error">{tc('noAccess')}</p>;
  if (!clients) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    const branchIds = f.getAll('branchIds').filter((v): v is string => typeof v === 'string');
    setBusy(true);
    setNotice(null);
    try {
      const made = await api<ApiClientCreatedDto>('/api-clients', {
        method: 'POST',
        body: { name: field(f, 'name').trim(), branchIds },
      });
      setCreated(made);
      setRecord([made.client, ...(clients ?? [])]);
      form.reset();
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm(t('revokeConfirm'))) return;
    setBusy(true);
    setNotice(null);
    try {
      const done = await api<ApiClientDto>(`/api-clients/${id}/revoke`, { method: 'POST' });
      setRecord((clients ?? []).map((c) => (c.id === id ? done : c)));
      setNotice({ ok: true, text: t('revoked') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('hint')}</p>
        </div>
      </div>
      <Notice notice={notice} />
      {created && (
        <div className="card stack">
          <strong>{t('createdTitle')}</strong>
          <p className="muted">{t('createdHint')}</p>
          <code dir="ltr" className="secret">
            {created.key}
          </code>
          <div className="actions">
            <button type="button" onClick={() => void navigator.clipboard.writeText(created.key)}>
              {t('copy')}
            </button>
            <button type="button" onClick={() => setCreated(null)}>
              {t('done')}
            </button>
          </div>
        </div>
      )}
      {can(me, 'users:create') && (
        <form className="card stack" onSubmit={(e) => void onCreate(e)}>
          <label className="field">
            <span>{t('name')}</span>
            <input name="name" required maxLength={100} placeholder={t('namePlaceholder')} />
          </label>
          <fieldset>
            <legend>{t('branches')}</legend>
            <div className="checks">
              {me.branches.map((b) => (
                <label key={b.id}>
                  <input type="checkbox" name="branchIds" value={b.id} />
                  {b.code} · {localName(b)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t('create')}
            </button>
          </div>
        </form>
      )}
      {clients.length === 0 ? (
        <p className="empty">{t('none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('key')}</th>
                <th>{t('branches')}</th>
                <th>{t('lastUsed')}</th>
                <th>{tc('status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className={c.isActive ? '' : 'inactive'}>
                  <td>
                    {c.name}
                    <div className="muted">
                      {c.createdByName} · {dateTime(c.createdAt)}
                    </div>
                  </td>
                  <td dir="ltr">{c.keyPrefix}…</td>
                  <td dir="ltr">{c.branchCodes.join(', ')}</td>
                  <td>{dateTime(c.lastUsedAt)}</td>
                  <td>
                    {c.isActive ? t('active') : t('revokedAt', { at: dateTime(c.revokedAt) })}
                  </td>
                  <td>
                    {c.isActive && can(me, 'users:update') && (
                      <button
                        type="button"
                        className="button small"
                        disabled={busy}
                        onClick={() => void revoke(c.id)}
                      >
                        {t('revoke')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
