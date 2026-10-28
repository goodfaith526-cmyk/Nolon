'use client';

import type {
  PaymentInstructionDto,
  PaymentInstructionInput,
  PaymentInstructionUpdate,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';

/**
 * How a customer pays, per branch and currency (plan 04 section 4.1). The shipping bot shows the
 * approved text of an approved request's branch and payment currency word for word. A draft is
 * edited; another person approves it, which retires the one it replaces; an approved text is never
 * edited, only retired. The API decides who may do each.
 */
export function PaymentInstructions() {
  const t = useTranslations('PaymentInstructions');
  const tc = useTranslations('Common');
  const me = useMe();
  const master = useMasterData();
  const name = useLocalName();
  const failure = useFailureText();
  const [rows, setRows] = useState<PaymentInstructionDto[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    api<PaymentInstructionDto[]>('/payment-instructions')
      .then(setRows)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [failure]);

  useEffect(load, [load]);

  // The branches where this person may write a draft (per branch, plan 03).
  const writable = me.branches.filter((b) =>
    me.branchPermissions
      ? me.branchPermissions.some(
          (p) => p.branchId === b.id && p.permissions.includes('payment_instructions:create'),
        )
      : me.permissions.includes('payment_instructions:create'),
  );

  async function run(
    path: string,
    method: 'POST' | 'PATCH',
    body: unknown,
    success: string,
  ): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await api(path, { method, body });
      setNotice({ ok: true, text: success });
      setAdding(false);
      setEditing(null);
      load();
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: PaymentInstructionInput = {
      branchId: field(form, 'branchId'),
      currency: field(form, 'currency'),
      textAr: field(form, 'textAr'),
      textEn: field(form, 'textEn'),
    };
    void run('/payment-instructions', 'POST', body, t('created'));
  }

  function save(e: FormEvent<HTMLFormElement>, row: PaymentInstructionDto) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: PaymentInstructionUpdate = {
      version: row.version,
      textAr: field(form, 'textAr'),
      textEn: field(form, 'textEn'),
    };
    void run(`/payment-instructions/${row.id}`, 'PATCH', body, t('saved'));
  }

  return (
    <main className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {!adding && writable.length > 0 && (
          <button type="button" onClick={() => setAdding(true)}>
            {t('add')}
          </button>
        )}
      </div>
      <p className="muted">{t('hint')}</p>
      <Notice notice={notice} />
      {adding && (
        <form className="card stack" autoComplete="off" onSubmit={add}>
          <div className="grid">
            <label className="field">
              {t('branch')}
              <select name="branchId" required defaultValue={writable[0]?.id}>
                {writable.map((b) => (
                  <option key={b.id} value={b.id}>
                    {name(b)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t('currency')}
              <select name="currency" required defaultValue={writable[0]?.defaultCurrency}>
                {master?.currencies
                  .filter((c) => c.isActive)
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <Texts />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
      {rows === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : rows.length === 0 ? (
        <p className="muted">{t('none')}</p>
      ) : (
        rows.map((r) =>
          editing === r.id ? (
            <form key={r.id} className="card stack" autoComplete="off" onSubmit={(e) => save(e, r)}>
              <h2 dir="ltr">
                {r.branchCode} · {r.currency}
              </h2>
              <Texts row={r} />
              <div className="actions">
                <button type="submit" className="primary" disabled={busy}>
                  {tc('save')}
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  {tc('cancel')}
                </button>
              </div>
            </form>
          ) : (
            <article
              key={r.id}
              className={`card stack${r.status === 'RETIRED' ? ' inactive' : ''}`}
            >
              <div className="row">
                <h2 dir="ltr">
                  {r.branchCode} · {r.currency}
                </h2>
                <StatusBadge kind="paymentInstruction" status={r.status} />
                <span className="muted" dir="ltr">
                  v{r.version}
                </span>
              </div>
              <p className="pre" dir="rtl" lang="ar">
                {r.textAr}
              </p>
              <p className="pre" dir="ltr" lang="en">
                {r.textEn}
              </p>
              <p className="muted">
                {t('madeBy', { name: r.createdByName })}
                {r.approvedByName && ` · ${t('approvedBy', { name: r.approvedByName })}`}
              </p>
              <div className="actions">
                {r.actions.canEdit && (
                  <button type="button" disabled={busy} onClick={() => setEditing(r.id)}>
                    {t('edit')}
                  </button>
                )}
                {r.actions.canApprove && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        `/payment-instructions/${r.id}/approve`,
                        'POST',
                        { version: r.version },
                        t('approved'),
                      )
                    }
                  >
                    {t('approve')}
                  </button>
                )}
                {r.actions.canRetire && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        `/payment-instructions/${r.id}/retire`,
                        'POST',
                        { version: r.version },
                        t('retired'),
                      )
                    }
                  >
                    {t('retire')}
                  </button>
                )}
              </div>
            </article>
          ),
        )
      )}
    </main>
  );
}

function Texts({ row }: { row?: PaymentInstructionDto }) {
  const t = useTranslations('PaymentInstructions');
  return (
    <>
      <label className="field">
        {t('textAr')}
        <textarea
          name="textAr"
          required
          maxLength={2000}
          dir="rtl"
          lang="ar"
          defaultValue={row?.textAr}
        />
      </label>
      <label className="field">
        {t('textEn')}
        <textarea
          name="textEn"
          required
          maxLength={2000}
          dir="ltr"
          lang="en"
          defaultValue={row?.textEn}
        />
      </label>
    </>
  );
}
