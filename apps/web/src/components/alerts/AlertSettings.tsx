'use client';

import { ALERT_MAX_DAYS, type AlertKind, type AlertSettingDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { useDateTime } from '../transport/common';

/** How many days each of the five alerts waits: the only thing about alerts that can change. */
export function AlertSettings() {
  const t = useTranslations('Alerts');
  const tc = useTranslations('Common');
  const me = useMe();
  const dateTime = useDateTime();
  const failure = useFailureText();
  const {
    record: settings,
    notice: loadNotice,
    setRecord,
  } = useRecord<AlertSettingDto[]>('/alerts/settings');
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState<AlertKind | null>(null);

  if (!can(me, 'alert_settings:view')) return <p className="error">{tc('noAccess')}</p>;
  if (!settings) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }
  const editable = can(me, 'alert_settings:update');

  async function onSave(event: FormEvent<HTMLFormElement>, kind: AlertKind) {
    event.preventDefault();
    const days = Number(field(new FormData(event.currentTarget), 'days'));
    setBusy(kind);
    setNotice(null);
    try {
      setRecord(
        await api<AlertSettingDto[]>(`/alerts/settings/${kind}`, { method: 'PUT', body: { days } }),
      );
      setNotice({ ok: true, text: tc('saved') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('settingsTitle')}</h1>
          <p className="muted">{t('settingsHint')}</p>
        </div>
        <Link href="/alerts" className="button">
          {tc('back')}
        </Link>
      </div>
      <Notice notice={notice} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('alert')}</th>
              <th>{t('waitDays')}</th>
              <th>{t('lastChange')}</th>
            </tr>
          </thead>
          <tbody>
            {settings.map((s) => (
              <tr key={s.kind}>
                <td>
                  {t(`kind_${s.kind}`)}
                  <div className="muted">{t(`rule_${s.kind}`, { days: s.days })}</div>
                </td>
                <td>
                  {editable ? (
                    <form className="line" onSubmit={(e) => void onSave(e, s.kind)}>
                      <input
                        name="days"
                        type="number"
                        min={0}
                        max={ALERT_MAX_DAYS}
                        step={1}
                        required
                        dir="ltr"
                        defaultValue={s.days}
                        key={`${s.kind}-${s.days}`}
                        aria-label={t('waitDays')}
                      />
                      <button type="submit" className="button small" disabled={busy !== null}>
                        {tc('save')}
                      </button>
                    </form>
                  ) : (
                    s.days
                  )}
                </td>
                <td>
                  {s.updatedByName ? (
                    <>
                      {s.updatedByName}
                      <div className="muted">{dateTime(s.updatedAt)}</div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
