'use client';

import {
  CUSTOMER_STAGE_STAFF_STATUSES,
  type CustomerStageDto,
  type CustomerStagesDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';

/**
 * Plan 09 section 3: the stages the customer reads from the bot, and which shipment status shows
 * as which. Master data: the Administrator edits it here, without code; a status with no stage
 * sends the customer to staff.
 */
const staffStatuses: ReadonlySet<string> = new Set(CUSTOMER_STAGE_STAFF_STATUSES);

export function CustomerStages({ editable }: { editable: boolean }) {
  const t = useTranslations('BotRequests');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const failure = useFailureText();
  const [data, setData] = useState<CustomerStagesDto | null>(null);
  const [editing, setEditing] = useState<CustomerStageDto | 'new' | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<CustomerStagesDto>('/customer-stages')
      .then(setData)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [failure]);
  useEffect(load, [load]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const code = editing === 'new' ? field(form, 'code').trim().toUpperCase() : editing?.code;
    if (!code) return;
    setBusy(true);
    setNotice(null);
    try {
      await api<CustomerStageDto>(`/customer-stages/${encodeURIComponent(code)}`, {
        method: 'PUT',
        body: {
          nameAr: field(form, 'nameAr').trim(),
          nameEn: field(form, 'nameEn').trim(),
          sortOrder: Number.parseInt(field(form, 'sortOrder'), 10),
          isActive: form.get('isActive') === 'on',
        },
      });
      setEditing(null);
      setNotice({ ok: true, text: tc('saved') });
      load();
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  async function map(status: string, stageCode: string) {
    setBusy(true);
    setNotice(null);
    try {
      setData(
        await api<CustomerStagesDto>(`/customer-stages/mapping/${encodeURIComponent(status)}`, {
          method: 'PUT',
          body: { stageCode: stageCode === '' ? null : stageCode },
        }),
      );
      setNotice({ ok: true, text: tc('saved') });
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  const stageName = (s: CustomerStageDto) => `${s.nameAr} · ${s.nameEn}`;

  return (
    <section className="card stack">
      <div className="row">
        <h2>{t('stages')}</h2>
        {editable && editing === null && (
          <button type="button" onClick={() => setEditing('new')}>
            {t('addStage')}
          </button>
        )}
      </div>
      <p className="muted">{t('stagesHint')}</p>
      <Notice notice={notice} />
      {editing !== null && (
        // Keyed by the stage edited (Codex F164-2): switching stages starts a fresh form.
        <form
          key={editing === 'new' ? 'new' : editing.code}
          className="stack"
          autoComplete="off"
          onSubmit={(e) => void save(e)}
        >
          <div className="grid">
            {editing === 'new' && (
              <label className="field">
                {t('stageCode')}
                <input name="code" required pattern="[A-Za-z][A-Za-z0-9_]{1,29}" dir="ltr" />
              </label>
            )}
            <label className="field">
              {t('textAr')}
              <input
                name="nameAr"
                required
                maxLength={100}
                dir="rtl"
                defaultValue={editing === 'new' ? '' : editing.nameAr}
              />
            </label>
            <label className="field">
              {t('textEn')}
              <input
                name="nameEn"
                required
                maxLength={100}
                dir="ltr"
                defaultValue={editing === 'new' ? '' : editing.nameEn}
              />
            </label>
            <label className="field">
              {t('stageOrder')}
              <input
                name="sortOrder"
                type="number"
                required
                min={1}
                max={99}
                dir="ltr"
                defaultValue={editing === 'new' ? '' : editing.sortOrder}
              />
            </label>
            <div className="checks">
              <label>
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={editing === 'new' ? true : editing.isActive}
                />
                {tc('active')}
              </label>
            </div>
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
      )}
      {data === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('stageOrder')}</th>
                  <th>{t('stageCode')}</th>
                  <th>{t('textAr')}</th>
                  <th>{t('textEn')}</th>
                  <th>{tc('status')}</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {data.stages.map((s) => (
                  <tr key={s.code} className={s.isActive ? '' : 'inactive'}>
                    <td dir="ltr">{s.sortOrder}</td>
                    <td dir="ltr">{s.code}</td>
                    <td dir="rtl">{s.nameAr}</td>
                    <td dir="ltr">{s.nameEn}</td>
                    <td>{s.isActive ? tc('active') : tc('inactive')}</td>
                    {editable && (
                      <td>
                        <button type="button" onClick={() => setEditing(s)}>
                          {tc('edit')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>{t('stageMapping')}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('shipmentStatus')}</th>
                  <th>{t('customerStage')}</th>
                </tr>
              </thead>
              <tbody>
                {data.mapping.map((m) => {
                  const staffOnly = staffStatuses.has(m.status);
                  return (
                    <tr key={m.status}>
                      <td>{te(`shipment_${m.status}`)}</td>
                      <td>
                        <select
                          value={m.stageCode ?? ''}
                          disabled={!editable || busy || staffOnly}
                          aria-label={t('customerStage')}
                          onChange={(e) => void map(m.status, e.target.value)}
                        >
                          <option value="">{t('stageToStaff')}</option>
                          {data.stages.map((s) => (
                            <option key={s.code} value={s.code}>
                              {stageName(s)}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
