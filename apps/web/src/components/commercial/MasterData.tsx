'use client';

import type {
  CodeNameDto,
  CodeNameInput,
  CodeNameUpdate,
  CurrencyDto,
  CurrencyInput,
  CurrencyUpdate,
  MasterDataDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { Tabs } from '../Tabs';
import { can, useMe } from '../StaffShell';
import { FormDialog } from './FormDialog';
import { Notice, type NoticeState, useFailureText } from './Notice';

/** The four lists of this page, by the API path that edits each. */
type ListKey = 'containerTypes' | 'chargeTypes' | 'documentTypes' | 'currencies';

interface ListSpec {
  key: ListKey;
  path: string;
  /** The code field: its length and the characters it takes (the API checks them too). */
  codeMax: number;
  codePattern: string;
}

const LISTS: readonly ListSpec[] = [
  { key: 'containerTypes', path: 'container-types', codeMax: 10, codePattern: '[A-Za-z0-9]+' },
  { key: 'chargeTypes', path: 'charge-types', codeMax: 20, codePattern: '[A-Za-z0-9]+' },
  {
    key: 'documentTypes',
    path: 'document-types',
    codeMax: 30,
    codePattern: '[A-Za-z0-9]+(_[A-Za-z0-9]+)*',
  },
  { key: 'currencies', path: 'currencies', codeMax: 3, codePattern: '[A-Za-z]{3}' },
];

type Entry = CodeNameDto & Partial<Pick<CurrencyDto, 'symbol' | 'decimalPlaces'>>;

/**
 * Container types, charge types, document types and currencies (master data): add, rename,
 * deactivate and reactivate. Nothing is deleted: an inactive entry stays on the records that
 * already name it, and the API refuses it on new ones.
 */
export function MasterData() {
  const t = useTranslations('MasterData');
  const tc = useTranslations('Common');
  const me = useMe();
  const failure = useFailureText();
  const [data, setData] = useState<MasterDataDto | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<MasterDataDto>('/master-data')
      .then(setData)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [failure]);

  useEffect(load, [load]);

  if (!can(me, 'master_data:view')) return <p className="error">{tc('noAccess')}</p>;

  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice({ ok: true, text: success });
      load();
      return true;
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
      return false;
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
      {data === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : (
        <Tabs
          label={t('title')}
          tabs={LISTS.map((spec) => ({
            key: spec.key,
            label: t(spec.key),
            content: (
              <MasterList
                spec={spec}
                entries={data[spec.key]}
                busy={busy}
                notice={notice}
                canCreate={can(me, 'master_data:create')}
                canUpdate={can(me, 'master_data:update')}
                run={run}
              />
            ),
          }))}
        />
      )}
    </section>
  );
}

function MasterList({
  spec,
  entries,
  busy,
  notice,
  canCreate,
  canUpdate,
  run,
}: {
  spec: ListSpec;
  entries: readonly Entry[];
  busy: boolean;
  /** The page's last message: a refused edit is shown in the dialog too, above the form. */
  notice: NoticeState | null;
  canCreate: boolean;
  canUpdate: boolean;
  run: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
}) {
  const t = useTranslations('MasterData');
  const tc = useTranslations('Common');
  const localName = useLocalName();
  const [editing, setEditing] = useState<Entry | null>(null);
  const isCurrency = spec.key === 'currencies';
  const base = `/master-data/${spec.path}`;

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const names: CodeNameInput = {
      code: field(form, 'code').trim().toUpperCase(),
      nameEn: field(form, 'nameEn').trim(),
      nameAr: field(form, 'nameAr').trim(),
    };
    const body: CodeNameInput | CurrencyInput = isCurrency
      ? {
          ...names,
          symbol: field(form, 'symbol').trim() || null,
          // A count of minor units (0 to 4), not an amount.
          decimalPlaces: Number(field(form, 'decimalPlaces')),
        }
      : names;
    if (await run(() => api(base, { method: 'POST', body }), t('createdNotice'))) element.reset();
  }

  async function onEdit(event: FormEvent<HTMLFormElement>, entry: Entry) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const names: CodeNameUpdate = {
      nameEn: field(form, 'nameEn').trim(),
      nameAr: field(form, 'nameAr').trim(),
    };
    const body: CodeNameUpdate | CurrencyUpdate = isCurrency
      ? { ...names, symbol: field(form, 'symbol').trim() || null }
      : names;
    const path = `${base}/${encodeURIComponent(entry.code)}`;
    if (await run(() => api(path, { method: 'PATCH', body }), tc('saved'))) setEditing(null);
  }

  function setActive(entry: Entry, active: boolean) {
    const path = `${base}/${encodeURIComponent(entry.code)}/${active ? 'reactivate' : 'deactivate'}`;
    void run(() => api(path, { method: 'POST' }), tc('saved'));
  }

  return (
    <>
      {canCreate && (
        <form className="card stack" onSubmit={(e) => void onCreate(e)}>
          <h2>{t(`add_${spec.key}`)}</h2>
          <div className="grid">
            <label className="field">
              <span>{t('code')}</span>
              <input
                name="code"
                required
                maxLength={spec.codeMax}
                minLength={isCurrency ? 3 : 1}
                dir="ltr"
                pattern={spec.codePattern}
                aria-describedby={`master-code-${spec.key}`}
              />
              <small id={`master-code-${spec.key}`} className="muted">
                {t('codeFixed')}
              </small>
            </label>
            <label className="field">
              <span>{t('nameAr')}</span>
              <input name="nameAr" required maxLength={200} dir="rtl" />
            </label>
            <label className="field">
              <span>{t('nameEn')}</span>
              <input name="nameEn" required maxLength={200} dir="ltr" />
            </label>
            {isCurrency && (
              <>
                <label className="field">
                  <span>{t('symbol')}</span>
                  <input name="symbol" maxLength={8} dir="ltr" />
                </label>
                <label className="field">
                  <span>{t('decimalPlaces')}</span>
                  <input
                    name="decimalPlaces"
                    type="number"
                    required
                    min={0}
                    max={4}
                    step={1}
                    defaultValue={2}
                    dir="ltr"
                    aria-describedby="master-decimals"
                  />
                  <small id="master-decimals" className="muted">
                    {t('decimalPlacesFixed')}
                  </small>
                </label>
              </>
            )}
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
          </div>
        </form>
      )}
      {entries.length === 0 ? (
        <p className="empty">{t('none')}</p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>{t('code')}</th>
                <th>{t('name')}</th>
                {isCurrency && <th>{t('symbol')}</th>}
                {isCurrency && <th>{t('decimalPlaces')}</th>}
                <th>{tc('status')}</th>
                {canUpdate && <th />}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.code} className={entry.isActive ? '' : 'inactive'}>
                  <td dir="ltr">{entry.code}</td>
                  <td>{localName(entry)}</td>
                  {isCurrency && <td dir="ltr">{entry.symbol ?? '—'}</td>}
                  {isCurrency && <td dir="ltr">{entry.decimalPlaces}</td>}
                  <td>{entry.isActive ? tc('active') : tc('inactive')}</td>
                  {canUpdate && (
                    <td>
                      <div className="actions">
                        <button type="button" disabled={busy} onClick={() => setEditing(entry)}>
                          {tc('edit')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setActive(entry, !entry.isActive)}
                        >
                          {entry.isActive ? tc('deactivate') : tc('activate')}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <FormDialog onClose={() => setEditing(null)}>
          <form className="card stack" onSubmit={(e) => void onEdit(e, editing)}>
            <h2>{t('editTitle', { code: editing.code })}</h2>
            {notice && !notice.ok && <Notice notice={notice} />}
            <div className="grid">
              <label className="field">
                <span>{t('nameAr')}</span>
                <input
                  name="nameAr"
                  required
                  maxLength={200}
                  dir="rtl"
                  defaultValue={editing.nameAr}
                />
              </label>
              <label className="field">
                <span>{t('nameEn')}</span>
                <input
                  name="nameEn"
                  required
                  maxLength={200}
                  dir="ltr"
                  defaultValue={editing.nameEn}
                />
              </label>
              {isCurrency && (
                <label className="field">
                  <span>{t('symbol')}</span>
                  <input
                    name="symbol"
                    maxLength={8}
                    dir="ltr"
                    defaultValue={editing.symbol ?? ''}
                  />
                </label>
              )}
            </div>
            <div className="actions">
              <button type="submit" className="primary" disabled={busy}>
                {tc('save')}
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                {tc('cancel')}
              </button>
            </div>
          </form>
        </FormDialog>
      )}
    </>
  );
}
