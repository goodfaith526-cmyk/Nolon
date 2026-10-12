'use client';

import type { CustomerDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { Money } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { CustomerForm } from './Customers';
import { Notice, type NoticeState, useFailureText } from './Notice';
import { PrintLink } from '../print/PrintLink';

type Mode = 'view' | 'edit' | 'contact' | 'party';

export function CustomerDetail({ id }: { id: string }) {
  const t = useTranslations('Customers');
  const tc = useTranslations('Common');
  const tp = useTranslations('Print');
  const me = useMe();
  const name = useLocalName();
  const failure = useFailureText();
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    api<CustomerDto>(`/customers/${id}`)
      .then(setCustomer)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [id, failure]);

  useEffect(load, [load]);

  if (!customer) {
    return notice ? <Notice notice={notice} /> : <p className="muted">{tc('loading')}</p>;
  }
  const canEdit = can(me, 'customers:update');
  const branch = me.branches.find((b) => b.id === customer.branchId);

  async function post(path: string, body: unknown, success: string) {
    setNotice(null);
    try {
      setCustomer(await api<CustomerDto>(path, { method: 'POST', body }));
      setMode('view');
      setNotice({ ok: true, text: success });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  function addContact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void post(
      `/customers/${customer?.id ?? ''}/contacts`,
      {
        name: field(form, 'name'),
        position: field(form, 'position') || null,
        phone: field(form, 'phone').replace(/\s/g, ''),
        email: field(form, 'email') || null,
        idNumber: field(form, 'idNumber') || null,
        canInquire: form.has('canInquire'),
        canReceiveCargo: form.has('canReceiveCargo'),
        canReceiveDocuments: form.has('canReceiveDocuments'),
        isPrimary: form.has('isPrimary'),
      },
      t('contactAdded'),
    );
  }

  function addParty(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void post(
      `/customers/${customer?.id ?? ''}/parties`,
      {
        name: field(form, 'name'),
        companyName: field(form, 'companyName') || null,
        phone: field(form, 'phone').replace(/\s/g, '') || null,
        email: field(form, 'email') || null,
        city: field(form, 'city') || null,
        address: field(form, 'address') || null,
      },
      t('partyAdded'),
    );
  }

  const yes = (v: boolean) => (v ? '✓' : '—');

  return (
    <section className="stack">
      <div className="row">
        <h1>
          {customer.name}{' '}
          <span className="muted" dir="ltr">
            {customer.number}
          </span>
        </h1>
        {mode === 'view' && (
          <div className="actions">
            {can(me, 'customer_invoices:view') && can(me, 'receipts:view') && (
              <PrintLink
                href={`/customers/${customer.id}/statement`}
                label={tp('printStatement')}
              />
            )}
            {canEdit && (
              <>
                <button type="button" onClick={() => setMode('edit')}>
                  {tc('edit')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void post(
                      `/customers/${customer.id}/${customer.isActive ? 'deactivate' : 'activate'}`,
                      undefined,
                      tc('saved'),
                    )
                  }
                >
                  {customer.isActive ? tc('deactivate') : tc('activate')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <Notice notice={notice} />

      {mode === 'edit' ? (
        <CustomerForm
          customer={customer}
          onCancel={() => setMode('view')}
          onSaved={(c) => {
            setCustomer(c);
            setMode('view');
            setNotice({ ok: true, text: tc('saved') });
          }}
        />
      ) : (
        <dl className="details">
          <dt>{t('branch')}</dt>
          <dd>{branch ? name(branch) : ''}</dd>
          <dt>{t('kind')}</dt>
          <dd>{t(`kind_${customer.kind}`)}</dd>
          <dt>{t('companyName')}</dt>
          <dd>{customer.companyName ?? '—'}</dd>
          <dt>{t('phone')}</dt>
          <dd dir="ltr">{customer.phone}</dd>
          <dt>{t('whatsapp')}</dt>
          <dd dir="ltr">{customer.whatsapp ?? '—'}</dd>
          <dt>{t('email')}</dt>
          <dd dir="ltr">{customer.email ?? '—'}</dd>
          <dt>{t('city')}</dt>
          <dd>{customer.city ?? '—'}</dd>
          <dt>{t('preferredCurrency')}</dt>
          <dd>{customer.preferredCurrency ?? '—'}</dd>
          <dt>{t('paymentTermsDays')}</dt>
          <dd>{customer.paymentTermsDays}</dd>
          <dt>{t('creditLimit')}</dt>
          <dd dir="ltr">
            {customer.creditLimit ? (
              <Money
                value={customer.creditLimit}
                currency={customer.creditLimitCurrency ?? undefined}
              />
            ) : (
              '—'
            )}
          </dd>
          <dt>{tc('status')}</dt>
          <dd>{customer.isActive ? tc('active') : tc('inactive')}</dd>
        </dl>
      )}

      <div className="row">
        <h2>{t('contacts')}</h2>
        {canEdit && mode === 'view' && (
          <button type="button" onClick={() => setMode('contact')}>
            {t('addContact')}
          </button>
        )}
      </div>
      {mode === 'contact' && (
        <form className="card stack" onSubmit={addContact}>
          <div className="grid">
            <label className="field">
              {t('name')}
              <input name="name" required maxLength={200} />
            </label>
            <label className="field">
              {t('position')}
              <input name="position" maxLength={100} />
            </label>
            <label className="field">
              {t('phone')}
              <input name="phone" required dir="ltr" placeholder="+249912345678" />
            </label>
            <label className="field">
              {t('email')}
              <input name="email" type="email" dir="ltr" />
            </label>
            <label className="field">
              {t('idNumber')}
              <input name="idNumber" maxLength={50} />
            </label>
          </div>
          <div className="checks">
            <label>
              <input type="checkbox" name="canInquire" defaultChecked /> {t('canInquire')}
            </label>
            <label>
              <input type="checkbox" name="canReceiveCargo" /> {t('canReceiveCargo')}
            </label>
            <label>
              <input type="checkbox" name="canReceiveDocuments" /> {t('canReceiveDocuments')}
            </label>
            <label>
              <input type="checkbox" name="isPrimary" /> {t('isPrimary')}
            </label>
          </div>
          <div className="actions">
            <button type="submit" className="primary">
              {tc('save')}
            </button>
            <button type="button" onClick={() => setMode('view')}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
      {customer.contacts.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('phone')}</th>
                <th>{t('canInquire')}</th>
                <th>{t('canReceiveCargo')}</th>
                <th>{t('canReceiveDocuments')}</th>
              </tr>
            </thead>
            <tbody>
              {customer.contacts.map((c) => (
                <tr key={c.id} className={c.isActive ? '' : 'inactive'}>
                  <td>
                    {c.name}
                    {c.isPrimary ? ` (${t('isPrimary')})` : ''}
                    {c.position ? <div className="muted">{c.position}</div> : null}
                  </td>
                  <td dir="ltr">{c.phone}</td>
                  <td>{yes(c.canInquire)}</td>
                  <td>{yes(c.canReceiveCargo)}</td>
                  <td>{yes(c.canReceiveDocuments)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row">
        <h2>{t('parties')}</h2>
        {canEdit && mode === 'view' && (
          <button type="button" onClick={() => setMode('party')}>
            {t('addParty')}
          </button>
        )}
      </div>
      <p className="muted">{t('partiesHint')}</p>
      {mode === 'party' && (
        <form className="card stack" onSubmit={addParty}>
          <div className="grid">
            <label className="field">
              {t('name')}
              <input name="name" required maxLength={200} />
            </label>
            <label className="field">
              {t('companyName')}
              <input name="companyName" maxLength={200} />
            </label>
            <label className="field">
              {t('phone')}
              <input name="phone" dir="ltr" placeholder="+249912345678" />
            </label>
            <label className="field">
              {t('email')}
              <input name="email" type="email" dir="ltr" />
            </label>
            <label className="field">
              {t('city')}
              <input name="city" maxLength={100} />
            </label>
            <label className="field">
              {t('address')}
              <input name="address" maxLength={500} />
            </label>
          </div>
          <div className="actions">
            <button type="submit" className="primary">
              {tc('save')}
            </button>
            <button type="button" onClick={() => setMode('view')}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
      {customer.parties.length > 0 && (
        <ul>
          {customer.parties.map((p) => (
            <li key={p.id}>
              {p.name}
              {p.companyName ? ` · ${p.companyName}` : ''}
              {p.city ? ` · ${p.city}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
