'use client';

import {
  type ApiClientDto,
  CS_OUTBOX_STATUSES,
  CS_WEBHOOK_DEFAULT_AUDIENCE,
  type CsWebhooksDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { Notice, type NoticeState, useFailureText } from './commercial/Notice';
import { useRecord } from './finance/common';
import { can, useMe } from './StaffShell';
import { useDateTime } from './transport/common';

/**
 * Plan 09 section 5: where a key's bot receives notices. One Administrator adds the address,
 * another approves it; the latest notices and their outcome show below. The API decides who may
 * approve (canApprove) and checks the address.
 */
export function ApiKeyWebhooks({ client, onClose }: { client: ApiClientDto; onClose: () => void }) {
  const t = useTranslations('ApiKeys');
  const me = useMe();
  const dateTime = useDateTime();
  const failure = useFailureText();
  const path = `/api-clients/${client.id}/webhooks`;
  const { record, notice: loadNotice, setRecord } = useRecord<CsWebhooksDto>(path);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<CsWebhooksDto>, done: string) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(await action());
      setNotice({ ok: true, text: done });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    void run(async () => {
      const next = await api<CsWebhooksDto>(path, {
        method: 'POST',
        body: { url: field(f, 'url').trim(), audience: field(f, 'audience').trim() },
      });
      form.reset();
      return next;
    }, t('webhookAdded'));
  }

  const act = (id: string, verb: 'approve' | 'retire') =>
    run(
      () => api<CsWebhooksDto>(`${path}/${id}/${verb}`, { method: 'POST' }),
      verb === 'approve' ? t('webhookApproved') : t('webhookRetired'),
    );

  return (
    <section className="card stack">
      <div className="actions">
        <h3>{t('webhooksTitle', { name: client.name })}</h3>
        <button type="button" className="button small" onClick={onClose}>
          {t('cancel')}
        </button>
      </div>
      <p className="muted">{t('webhooksHint')}</p>
      <Notice notice={notice ?? loadNotice} />
      {record && (
        <>
          {!record.secretConfigured && <p className="error">{t('webhookNoSecret')}</p>}
          {!record.workerEnabled && <p className="muted">{t('webhookWorkerOff')}</p>}
          <p className="muted">
            {t('webhookAllowedHosts')} <bdi dir="ltr">{record.allowedHosts.join(', ') || '—'}</bdi>
          </p>
          {record.endpoints.length === 0 ? (
            <p className="empty">{t('webhookNone')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('webhookUrl')}</th>
                    <th>{t('webhookAudience')}</th>
                    <th>{t('webhookStatus')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {record.endpoints.map((e) => (
                    <tr key={e.id} className={e.status === 'RETIRED' ? 'inactive' : ''}>
                      <td dir="ltr">{e.url}</td>
                      <td dir="ltr">{e.audience}</td>
                      <td>
                        {t(`webhook_${e.status}`)}
                        <div className="muted">
                          <bdi>{e.createdByName}</bdi> · <bdi>{dateTime(e.createdAt)}</bdi>
                          {e.approvedByName && (
                            <>
                              {' · '}
                              {t('webhookApprovedBy', { name: e.approvedByName })}
                            </>
                          )}
                        </div>
                      </td>
                      <td>
                        {e.canApprove && can(me, 'users:update') && (
                          <button
                            type="button"
                            className="button small primary"
                            disabled={busy || !record.secretConfigured}
                            onClick={() => void act(e.id, 'approve')}
                          >
                            {t('webhookApprove')}
                          </button>
                        )}
                        {e.status !== 'RETIRED' && can(me, 'users:update') && (
                          <button
                            type="button"
                            className="button small"
                            disabled={busy}
                            onClick={() => void act(e.id, 'retire')}
                          >
                            {t('webhookRetire')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {client.isActive && can(me, 'users:create') && (
            <form className="stack" onSubmit={onAdd}>
              <label>
                {t('webhookUrl')}
                <input name="url" type="url" required maxLength={500} dir="ltr" />
              </label>
              <label>
                {t('webhookAudience')}
                <input
                  name="audience"
                  required
                  maxLength={100}
                  dir="ltr"
                  defaultValue={CS_WEBHOOK_DEFAULT_AUDIENCE}
                />
              </label>
              <div className="actions">
                <button type="submit" className="button small primary" disabled={busy}>
                  {t('webhookAdd')}
                </button>
              </div>
            </form>
          )}
          <h4>{t('webhookRecent')}</h4>
          <p className="muted">
            {CS_OUTBOX_STATUSES.map((s) => `${t(`outbox_${s}`)}: ${record.counts[s]}`).join(' · ')}
          </p>
          {record.recent.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('webhookRequest')}</th>
                    <th>{t('webhookEvent')}</th>
                    <th>{t('webhookStatus')}</th>
                    <th>{t('webhookAttempts')}</th>
                    <th>{t('webhookLastAnswer')}</th>
                  </tr>
                </thead>
                <tbody>
                  {record.recent.map((r) => (
                    <tr key={r.id}>
                      <td dir="ltr">
                        {r.requestReference} #{r.sequence}
                      </td>
                      <td dir="ltr">{r.type}</td>
                      <td>
                        {t(`outbox_${r.status}`)}
                        <div className="muted">{dateTime(r.sentAt ?? r.occurredAt)}</div>
                      </td>
                      <td>{r.attempts}</td>
                      <td dir="ltr">{r.lastStatus ?? r.lastError ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
