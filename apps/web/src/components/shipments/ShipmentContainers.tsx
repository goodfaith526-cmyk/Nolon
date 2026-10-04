'use client';

import type { ShipmentDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';

/** Containers on the shipment: number (ISO 6346), seal and type. */
export function ShipmentContainers({
  shipment,
  onChange,
}: {
  shipment: ShipmentDto;
  onChange: (s: ShipmentDto) => void;
}) {
  const t = useTranslations('Shipments');
  const tc = useTranslations('Common');
  const master = useMasterData();
  const failure = useFailureText();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const editable = shipment.actions.canEdit;

  async function run(path: string, method: string, body?: unknown) {
    setNotice(null);
    try {
      onChange(
        await api<ShipmentDto>(`/shipments/${shipment.id}/containers${path}`, { method, body }),
      );
      setAdding(false);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    }
  }

  function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run('', 'POST', {
      containerNumber: field(form, 'containerNumber'),
      sealNumber: field(form, 'sealNumber') || null,
      containerTypeCode: field(form, 'containerTypeCode'),
    });
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('containers')}</h2>
        {editable && !adding && (
          <button type="button" onClick={() => setAdding(true)}>
            {t('addContainer')}
          </button>
        )}
      </div>
      <Notice notice={notice} />
      {adding && (
        <form className="line inset" onSubmit={onAdd}>
          <label className="field">
            <span>{t('containerNumber')}</span>
            <input
              name="containerNumber"
              required
              dir="ltr"
              placeholder="MSCU1234565"
              maxLength={15}
            />
          </label>
          <label className="field">
            <span>{t('sealNumber')}</span>
            <input name="sealNumber" dir="ltr" maxLength={30} />
          </label>
          <label className="field">
            <span>{t('containerType')}</span>
            <select name="containerTypeCode" required>
              {master?.containerTypes
                .filter((c) => c.isActive)
                .map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit" className="primary">
            {tc('save')}
          </button>
          <button type="button" onClick={() => setAdding(false)}>
            {tc('back')}
          </button>
        </form>
      )}
      {shipment.containers.length === 0 ? (
        <p className="empty">{t('noContainers')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('containerNumber')}</th>
              <th>{t('sealNumber')}</th>
              <th>{t('containerType')}</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {shipment.containers.map((c) => (
              <tr key={c.id}>
                <td dir="ltr">{c.containerNumber}</td>
                <td dir="ltr">{c.sealNumber ?? '—'}</td>
                <td>{c.containerTypeCode}</td>
                {editable && (
                  <td>
                    <button type="button" onClick={() => void run(`/${c.id}`, 'DELETE')}>
                      {tc('remove')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
