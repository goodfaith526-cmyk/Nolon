'use client';

import type { ShipmentConsolidationDto, ShipmentDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { ShipmentConsolidations } from '../consolidations/ShipmentConsolidations';
import { StatusBadge } from '../StatusBadge';

/**
 * The containers tab: for an LCL shipment, the consolidated containers it is (or was) in, and its
 * own containers. While it is in a consolidated container (not cancelled), that container is its
 * container (functional review D4): shown read-only, with no "add container", so it is not typed
 * twice. Containers already on the shipment stay listed as they are.
 */
export function ShipmentContainersTab({
  shipment,
  onChange,
}: {
  shipment: ShipmentDto;
  onChange: (s: ShipmentDto) => void;
}) {
  const lcl = shipment.loadType === 'LCL';
  const [list, setList] = useState<ShipmentConsolidationDto[] | null>(null);
  const onLoaded = useCallback((items: ShipmentConsolidationDto[]) => setList(items), []);
  return (
    <>
      {lcl && <ShipmentConsolidations shipmentId={shipment.id} onLoaded={onLoaded} />}
      <ShipmentContainers
        shipment={shipment}
        onChange={onChange}
        consolidation={lcl ? (list?.find((c) => c.status !== 'CANCELLED') ?? null) : null}
      />
    </>
  );
}

/** Containers on the shipment: number (ISO 6346), seal and type. */
export function ShipmentContainers({
  shipment,
  onChange,
  consolidation = null,
}: {
  shipment: ShipmentDto;
  onChange: (s: ShipmentDto) => void;
  /** The consolidated container the shipment is in (D4): read-only, and no "add container". */
  consolidation?: ShipmentConsolidationDto | null;
}) {
  const t = useTranslations('Shipments');
  const tc = useTranslations('Common');
  const master = useMasterData();
  const failure = useFailureText();
  const [adding, setAdding] = useState(false);
  const [typePicked, setTypePicked] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const editable = shipment.actions.canEdit;
  // Container type (functional review D5): defaults when the add form opens to the booking
  // lines' container type when they have exactly one; with none or several it waits for a pick.
  // The person's pick is kept (an uncontrolled select); the hint goes once they pick.
  const lineTypes = [
    ...new Set(shipment.items.flatMap((i) => (i.containerTypeCode ? [i.containerTypeCode] : []))),
  ];
  const lineType = lineTypes.length === 1 ? lineTypes[0] : undefined;
  const defaultType =
    lineType && master?.containerTypes.some((c) => c.isActive && c.code === lineType)
      ? lineType
      : '';

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
        {editable && !adding && !consolidation && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setTypePicked(false);
            }}
          >
            {t('addContainer')}
          </button>
        )}
      </div>
      <Notice notice={notice} />
      {consolidation && (
        <div className="panel-body stack">
          <p className="muted">
            {t('inConsolidation', { number: consolidation.number })}{' '}
            <StatusBadge kind="consolidation" status={consolidation.status} />
          </p>
          <dl className="details flat">
            <dt>{t('containerNumber')}</dt>
            <dd dir="ltr">{consolidation.containerNumber ?? '—'}</dd>
            <dt>{t('sealNumber')}</dt>
            <dd dir="ltr">{consolidation.sealNumber ?? '—'}</dd>
            <dt>{t('containerType')}</dt>
            <dd dir="ltr">{consolidation.containerTypeCode}</dd>
          </dl>
        </div>
      )}
      {adding && !consolidation && (
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
            <select
              name="containerTypeCode"
              required
              defaultValue={defaultType}
              onChange={() => setTypePicked(true)}
            >
              <option value="" disabled>
                —
              </option>
              {master?.containerTypes
                .filter((c) => c.isActive)
                .map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
            </select>
            {defaultType && !typePicked && (
              <small className="muted">{t('containerTypeFromBooking')}</small>
            )}
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
