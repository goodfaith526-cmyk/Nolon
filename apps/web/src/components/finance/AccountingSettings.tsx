'use client';

import {
  POSTING_ROLES,
  type AccountDto,
  type AccountingSettingsDto,
  type PostingRole,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { useRecord } from './common';

/** Which account each automatic posting uses: posting roles, then revenue per charge type. */
export function AccountingSettings({ accounts }: { accounts: AccountDto[] }) {
  const t = useTranslations('Accounts');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const { record: loaded, notice: loadNotice } =
    useRecord<AccountingSettingsDto>('/accounting/settings');
  const [saved, setSaved] = useState<AccountingSettingsDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const settings = saved ?? loaded;
  const canUpdate = can(me, 'chart_of_accounts:update');

  async function put(path: string, body: unknown) {
    setBusy(true);
    setNotice(null);
    try {
      setSaved(await api<AccountingSettingsDto>(path, { method: 'PUT', body }));
      setNotice({ ok: true, text: tc('saved') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function onMapping(e: FormEvent<HTMLFormElement>, role: PostingRole) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void put(`/accounting/settings/mappings/${role}`, { accountId: field(form, 'accountId') });
  }

  function onChargeType(e: FormEvent<HTMLFormElement>, code: string) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void put(`/accounting/settings/charge-types/${encodeURIComponent(code)}`, {
      revenueAccountId: field(form, 'revenueAccountId') || null,
      isReimbursable: form.get('isReimbursable') === 'on',
    });
  }

  if (!settings) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  const postable = accounts.filter((a) => a.isPostable && a.isActive);
  const label = (a: AccountDto) => `${a.code} · ${name(a)}`;

  return (
    <div className="stack">
      <h2>{t('settingsTitle')}</h2>
      <Notice notice={notice} />
      <div className="panel">
        <div className="panel-head">
          <h2>{t('mappingsTitle')}</h2>
        </div>
        <p className="panel-body muted">{t('mappingsHint')}</p>
        <table>
          <thead>
            <tr>
              <th>{t('role')}</th>
              <th>{t('account')}</th>
              {canUpdate && <th />}
            </tr>
          </thead>
          <tbody>
            {POSTING_ROLES.map((role) => {
              const current = settings.mappings.find((m) => m.role === role)?.accountId ?? '';
              const formId = `mapping-${role}`;
              return (
                <tr key={`${role}-${current}`}>
                  <td>{te(`postingRole_${role}`)}</td>
                  <td>
                    <form id={formId} onSubmit={(e) => onMapping(e, role)} />
                    <select
                      form={formId}
                      name="accountId"
                      required
                      disabled={!canUpdate}
                      defaultValue={current}
                      aria-label={te(`postingRole_${role}`)}
                    >
                      <option value="">{t('notMapped')}</option>
                      {postable.map((a) => (
                        <option key={a.id} value={a.id}>
                          {label(a)}
                        </option>
                      ))}
                    </select>
                  </td>
                  {canUpdate && (
                    <td>
                      <button type="submit" form={formId} disabled={busy}>
                        {tc('save')}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{t('chargeTypesTitle')}</h2>
        </div>
        <p className="panel-body muted">{t('chargeTypesHint')}</p>
        <table>
          <thead>
            <tr>
              <th>{t('chargeType')}</th>
              <th>{t('revenueAccount')}</th>
              <th>{t('reimbursable')}</th>
              {canUpdate && <th />}
            </tr>
          </thead>
          <tbody>
            {(master?.chargeTypes ?? []).map((c) => {
              const posting = settings.chargeTypes.find((p) => p.chargeTypeCode === c.code);
              const formId = `charge-${c.code}`;
              const revenueId = posting?.revenueAccountId ?? '';
              const reimbursable = posting?.isReimbursable ?? false;
              return (
                <tr key={`${c.code}-${revenueId}-${String(reimbursable)}`}>
                  <td>
                    {name(c)}{' '}
                    <span className="muted" dir="ltr">
                      {c.code}
                    </span>
                  </td>
                  <td>
                    <form id={formId} onSubmit={(e) => onChargeType(e, c.code)} />
                    <select
                      form={formId}
                      name="revenueAccountId"
                      disabled={!canUpdate}
                      defaultValue={revenueId}
                      aria-label={t('revenueAccount')}
                    >
                      <option value="">{t('defaultAccount')}</option>
                      {postable.map((a) => (
                        <option key={a.id} value={a.id}>
                          {label(a)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      form={formId}
                      name="isReimbursable"
                      disabled={!canUpdate}
                      defaultChecked={reimbursable}
                      aria-label={t('reimbursable')}
                    />
                  </td>
                  {canUpdate && (
                    <td>
                      <button type="submit" form={formId} disabled={busy}>
                        {tc('save')}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
