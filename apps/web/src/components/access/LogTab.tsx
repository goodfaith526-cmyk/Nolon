'use client';

import type { AuditLogEntryDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { AuditChanges } from '../operations/reports/OperationalReports';
import { type AccessNotice, NoticeLine, useAccessNotice } from './AccessCommon';

/** Log: the last permission changes (teams, people, branch limits, delegations). */
export function LogTab() {
  const t = useTranslations('Access');
  const tOps = useTranslations('OpsReports');
  const locale = useLocale();
  const failure = useAccessNotice();
  const [entries, setEntries] = useState<AuditLogEntryDto[] | null>(null);
  const [notice, setNotice] = useState<AccessNotice | null>(null);
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  const load = useCallback(() => {
    api<AuditLogEntryDto[]>('/access-control/log?limit=100')
      .then((list) => {
        setEntries(list);
        setNotice(null);
      })
      .catch((e: unknown) => setNotice(failure(e)));
  }, [failure]);
  useEffect(load, [load]);

  return (
    <div className="stack">
      <div className="row">
        <p className="muted">{t('logHint')}</p>
        <button type="button" onClick={load}>
          {t('reload')}
        </button>
      </div>
      <NoticeLine notice={notice} onReload={load} />
      {entries === null ? (
        !notice && <p className="muted">{t('loading')}</p>
      ) : entries.length === 0 ? (
        <p className="muted">{t('noLog')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{tOps('when')}</th>
                <th>{t('branch')}</th>
                <th>{tOps('user')}</th>
                <th>{tOps('entity')}</th>
                <th>{tOps('action')}</th>
                <th>{tOps('reference')}</th>
                <th>{tOps('changes')}</th>
                <th>{tOps('detail')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.at}-${e.entity}-${e.reference}-${i}`}>
                  <td>{time.format(new Date(e.at))}</td>
                  <td dir="ltr">{e.branchCode}</td>
                  <td>{e.userName ?? tOps('notRecorded')}</td>
                  <td>{tOps(`entity_${e.entity}`)}</td>
                  <td>{tOps(`action_${e.action}`)}</td>
                  <td dir="ltr">{e.reference}</td>
                  <td className="wrap">
                    <AuditChanges entry={e} />
                  </td>
                  <td className="wrap">{e.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
