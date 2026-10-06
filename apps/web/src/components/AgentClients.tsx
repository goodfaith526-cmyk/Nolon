'use client';

import type { AgentClientCreatedDto, AgentClientDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { Notice, type NoticeState, useFailureText } from './commercial/Notice';
import { useRecord } from './finance/common';
import { can, useMe } from './StaffShell';
import { useDateTime } from './transport/common';

/** Assistant platforms allowed to sign staff in with NOLON (delegated, read-only, short tokens). */
export function AgentClients() {
  const t = useTranslations('AgentClients');
  const tc = useTranslations('Common');
  const tk = useTranslations('ApiKeys');
  const me = useMe();
  const dateTime = useDateTime();
  const failure = useFailureText();
  const {
    record: clients,
    notice: loadNotice,
    setRecord,
  } = useRecord<AgentClientDto[]>('/agent-clients');
  const [created, setCreated] = useState<AgentClientCreatedDto | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  if (!can(me, 'users:view')) return null;
  if (!clients) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setNotice(null);
    try {
      const made = await api<AgentClientCreatedDto>('/agent-clients', {
        method: 'POST',
        body: {
          name: field(f, 'name').trim(),
          redirectUri: field(f, 'redirectUri').trim(),
          audience: field(f, 'audience').trim(),
          tenant: field(f, 'tenant').trim(),
        },
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
      const done = await api<AgentClientDto>(`/agent-clients/${id}/revoke`, { method: 'POST' });
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
          <h2>{t('title')}</h2>
          <p className="muted">{t('hint')}</p>
        </div>
      </div>
      <Notice notice={notice} />
      {created && (
        <div className="card stack">
          <strong>{t('createdTitle')}</strong>
          <p className="muted">{tk('createdHint')}</p>
          <div>
            {t('clientId')}: <code dir="ltr">{created.client.clientId}</code>
          </div>
          <code dir="ltr" className="secret">
            {created.clientSecret}
          </code>
          <div className="actions">
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(created.clientSecret)}
            >
              {tk('copy')}
            </button>
            <button type="button" onClick={() => setCreated(null)}>
              {tk('done')}
            </button>
          </div>
        </div>
      )}
      {can(me, 'users:create') && (
        <form className="card stack" onSubmit={(e) => void onCreate(e)}>
          <label className="field">
            <span>{tk('name')}</span>
            <input name="name" required maxLength={100} />
          </label>
          <label className="field">
            <span>{t('redirectUri')}</span>
            <input name="redirectUri" required maxLength={500} dir="ltr" type="url" />
          </label>
          <label className="field">
            <span>{t('audience')}</span>
            <input name="audience" required maxLength={100} dir="ltr" />
          </label>
          <label className="field">
            <span>{t('tenant')}</span>
            <input name="tenant" required maxLength={100} dir="ltr" />
          </label>
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
                <th>{tk('name')}</th>
                <th>{t('clientId')}</th>
                <th>{t('redirectUri')}</th>
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
                      <bdi>{c.createdByName}</bdi> · <bdi>{dateTime(c.createdAt)}</bdi>
                    </div>
                  </td>
                  <td dir="ltr">{c.clientId}</td>
                  <td dir="ltr">{c.redirectUri}</td>
                  <td>
                    {c.isActive ? tk('active') : tk('revokedAt', { at: dateTime(c.revokedAt) })}
                  </td>
                  <td>
                    {c.isActive && can(me, 'users:update') && (
                      <button
                        type="button"
                        className="button small"
                        disabled={busy}
                        onClick={() => void revoke(c.id)}
                      >
                        {tk('revoke')}
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
