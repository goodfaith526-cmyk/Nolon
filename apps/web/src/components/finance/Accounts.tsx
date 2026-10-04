'use client';

import { ACCOUNT_TYPES, type AccountDto, type AccountInput, type AccountType } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { AccountingSettings } from './AccountingSettings';
import { useBranchCode, useRecord } from './common';

/** Accounts in tree order (each parent followed by its children), with their depth. */
function treeOrder(accounts: AccountDto[]): { account: AccountDto; depth: number }[] {
  const ids = new Set(accounts.map((a) => a.id));
  const children = new Map<string | null, AccountDto[]>();
  for (const a of accounts) {
    const parent = a.parentId && ids.has(a.parentId) ? a.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), a]);
  }
  const result: { account: AccountDto; depth: number }[] = [];
  const visit = (parent: string | null, depth: number) => {
    const list = [...(children.get(parent) ?? [])].sort((x, y) => x.code.localeCompare(y.code));
    for (const a of list) {
      result.push({ account: a, depth });
      visit(a.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
}

export function Accounts() {
  const t = useTranslations('Accounts');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const name = useLocalName();
  const branchCode = useBranchCode(me);
  const { record: loaded, notice: loadNotice } = useRecord<AccountDto[]>('/accounting/accounts');
  const [saved, setSaved] = useState<AccountDto[] | null>(null);
  const [editing, setEditing] = useState<AccountDto | 'new' | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!can(me, 'chart_of_accounts:view')) return <p className="error">{tc('noAccess')}</p>;
  const accounts = saved ?? loaded;

  function onSaved(account: AccountDto) {
    const list = accounts ?? [];
    setSaved(
      list.some((a) => a.id === account.id)
        ? list.map((a) => (a.id === account.id ? account : a))
        : [...list, account],
    );
    setEditing(null);
    setNotice({ ok: true, text: tc('saved') });
  }

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {can(me, 'chart_of_accounts:create') && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              setNotice(null);
              setEditing('new');
            }}
          >
            {t('add')}
          </button>
        )}
      </div>
      <Notice notice={notice ?? loadNotice} />
      {editing && accounts && (
        <AccountForm
          key={editing === 'new' ? 'new' : editing.id}
          account={editing === 'new' ? undefined : editing}
          accounts={accounts}
          onSaved={onSaved}
          onCancel={() => setEditing(null)}
        />
      )}
      {accounts === null ? (
        !loadNotice && <p className="muted">{tc('loading')}</p>
      ) : accounts.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('code')}</th>
                <th>{t('name')}</th>
                <th>{t('type')}</th>
                <th>{t('flags')}</th>
                <th>{t('currency')}</th>
                <th>{t('branch')}</th>
                <th>{tc('status')}</th>
                {can(me, 'chart_of_accounts:update') && <th />}
              </tr>
            </thead>
            <tbody>
              {treeOrder(accounts).map(({ account: a, depth }) => (
                <tr key={a.id} className={a.isActive ? '' : 'inactive'}>
                  <td dir="ltr">{a.code}</td>
                  <td>
                    <span
                      className={a.isPostable ? 'tree-name' : 'tree-name heading'}
                      style={{ paddingInlineStart: `${depth * 1.25}rem` }}
                    >
                      {name(a)}
                    </span>
                  </td>
                  <td>{te(`accountType_${a.type}`)}</td>
                  <td>
                    <span className="actions">
                      {!a.isPostable && <span className="badge">{t('header')}</span>}
                      {a.isCash && <span className="badge badge-info">{t('cash')}</span>}
                      {a.isControl && <span className="badge badge-warn">{t('control')}</span>}
                    </span>
                  </td>
                  <td dir="ltr">{a.currency ?? '—'}</td>
                  <td dir="ltr">{a.branchId ? branchCode(a.branchId) : '—'}</td>
                  <td>{a.isActive ? tc('active') : tc('inactive')}</td>
                  {can(me, 'chart_of_accounts:update') && (
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setNotice(null);
                          setEditing(a);
                        }}
                      >
                        {tc('edit')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {accounts && <AccountingSettings accounts={accounts} />}
    </section>
  );
}

function AccountForm({
  account,
  accounts,
  onSaved,
  onCancel,
}: {
  account?: AccountDto;
  accounts: AccountDto[];
  onSaved: (account: AccountDto) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('Accounts');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: AccountInput = {
      code: field(form, 'code').trim(),
      nameEn: field(form, 'nameEn').trim(),
      nameAr: field(form, 'nameAr').trim(),
      type: field(form, 'type') as AccountType,
      parentId: field(form, 'parentId') || null,
      isPostable: form.get('isPostable') === 'on',
      isCash: form.get('isCash') === 'on',
      currency: field(form, 'currency') || null,
      branchId: field(form, 'branchId') || null,
      isActive: form.get('isActive') === 'on',
    };
    setBusy(true);
    setNotice(null);
    try {
      onSaved(
        account
          ? await api<AccountDto>(`/accounting/accounts/${account.id}`, {
              method: 'PATCH',
              body,
            })
          : await api<AccountDto>('/accounting/accounts', { method: 'POST', body }),
      );
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  const parents = accounts.filter((a) => !a.isPostable && a.id !== account?.id);

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h2>{account ? t('editTitle', { code: account.code }) : t('add')}</h2>
      <Notice notice={notice} />
      <div className="grid">
        <label className="field">
          {t('code')}
          <input
            name="code"
            required
            dir="ltr"
            maxLength={20}
            pattern="[0-9A-Za-z][0-9A-Za-z.\-]{0,19}"
            defaultValue={account?.code}
          />
        </label>
        <label className="field">
          {t('type')}
          <select name="type" defaultValue={account?.type ?? 'ASSET'}>
            {ACCOUNT_TYPES.map((type) => (
              <option key={type} value={type}>
                {te(`accountType_${type}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('nameAr')}
          <input name="nameAr" required maxLength={200} dir="rtl" defaultValue={account?.nameAr} />
        </label>
        <label className="field">
          {t('nameEn')}
          <input name="nameEn" required maxLength={200} dir="ltr" defaultValue={account?.nameEn} />
        </label>
        <label className="field">
          {t('parent')}
          <select name="parentId" defaultValue={account?.parentId ?? ''}>
            <option value="">{t('noParent')}</option>
            {parents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {name(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('currency')}
          <select name="currency" defaultValue={account?.currency ?? ''}>
            <option value="">{t('anyCurrency')}</option>
            {(master?.currencies ?? [])
              .filter((c) => c.isActive || c.code === account?.currency)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          {t('branch')}
          <select name="branchId" defaultValue={account?.branchId ?? ''}>
            <option value="">{t('allBranches')}</option>
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {name(b)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="checks">
        <label>
          <input type="checkbox" name="isPostable" defaultChecked={account?.isPostable ?? true} />
          {t('isPostable')}
        </label>
        <label>
          <input type="checkbox" name="isCash" defaultChecked={account?.isCash ?? false} />
          {t('isCash')}
        </label>
        <label>
          <input type="checkbox" name="isActive" defaultChecked={account?.isActive ?? true} />
          {tc('active')}
        </label>
      </div>
      <p className="muted">{t('formHint')}</p>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {tc('save')}
        </button>
        <button type="button" onClick={onCancel}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
