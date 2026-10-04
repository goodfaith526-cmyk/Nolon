'use client';

import {
  GOODS_CONDITIONS,
  MAX_DOCUMENT_BYTES,
  type GoodsCondition,
  type GoodsReceiptRequest,
  type GoodsReleaseRequest,
  type ShipmentDto,
  type ShipmentWarehouseDto,
  type WarehouseDto,
  type WarehouseMovementDto,
  type WarehouseReceiptStatus,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { StatusBadge } from '../StatusBadge';
import { PrintLink } from '../print/PrintLink';

type Form = 'receipt' | 'release' | null;

/** Weight inputs: what the API accepts (up to 9 integer and 3 decimal digits). */
const WEIGHT_PATTERN = '\\d{1,9}(\\.\\d{1,3})?';

/** datetime-local value (local time, no zone) to an ISO timestamp with offset. */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Uploads one photo of a movement; the API checks the content, size and permissions. */
async function uploadPhoto(
  shipmentId: string,
  movementId: string,
  file: File,
): Promise<WarehouseMovementDto> {
  const form = new FormData();
  form.set('file', file);
  // The name goes as a text field so Arabic names arrive intact.
  form.set('fileName', file.name);
  const res = await fetch(
    `/api/v1/shipments/${shipmentId}/warehouse/movements/${movementId}/photos`,
    {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    },
  );
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return (await res.json()) as WarehouseMovementDto;
}

/**
 * The shipment's warehouse section: what each warehouse holds, goods receipt (GRN) and release
 * forms, and the movement log. The API decides what is allowed (actions) and checks every rule.
 */
export function ShipmentWarehouse({
  shipment,
  onShipmentChanged,
}: {
  shipment: ShipmentDto;
  onShipmentChanged: () => void;
}) {
  const t = useTranslations('Warehouse');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const tp = useTranslations('Print');
  const locale = useLocale();
  const localName = useLocalName();
  const failure = useFailureText();
  const [data, setData] = useState<ShipmentWarehouseDto | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseDto[]>([]);
  const [form, setForm] = useState<Form>(null);
  const [receiptWarehouse, setReceiptWarehouse] = useState('');
  const [releasePackages, setReleasePackages] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const shipmentId = shipment.id;

  const load = useCallback(() => {
    api<ShipmentWarehouseDto>(`/shipments/${shipmentId}/warehouse`)
      .then(setData)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [shipmentId, failure]);

  useEffect(load, [load]);
  useEffect(() => {
    let cancelled = false;
    api<WarehouseDto[]>('/warehouses')
      .then((list) => {
        if (!cancelled) setWarehouses(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>{t('section')}</h2>
        </div>
        {notice ? (
          <div className="panel-body">
            <Notice notice={notice} />
          </div>
        ) : (
          <p className="empty">{tc('loading')}</p>
        )}
      </div>
    );
  }

  const actions = data.actions;
  const activeWarehouses = warehouses.filter((w) => w.isActive);
  const selectedWarehouse =
    activeWarehouses.find((w) => w.id === receiptWarehouse) ?? activeWarehouses[0];
  const held = data.balances.filter((b) => b.onHandPackages > 0);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  async function submit(path: string, body: unknown, success: (m: WarehouseMovementDto) => string) {
    setBusy(true);
    setNotice(null);
    try {
      const movement = await api<WarehouseMovementDto>(
        `/shipments/${shipmentId}/warehouse/${path}`,
        { method: 'POST', body },
      );
      setForm(null);
      setReleasePackages('');
      setNotice({ ok: true, text: success(movement) });
      load();
      if (movement.statusApplied) onShipmentChanged();
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function onReceive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const body: GoodsReceiptRequest = {
      warehouseId: field(f, 'warehouseId'),
      storageLocationId: field(f, 'storageLocationId') || null,
      packages: Number.parseInt(field(f, 'packages'), 10),
      weightKg: field(f, 'weightKg').trim() || null,
      condition: field(f, 'condition') as GoodsCondition,
      partyName: field(f, 'partyName').trim() || null,
      note: field(f, 'note').trim() || null,
      occurredAt: toIso(field(f, 'occurredAt')),
      shipmentStatus: (field(f, 'shipmentStatus') || null) as WarehouseReceiptStatus | null,
    };
    void submit('receipts', body, (m) =>
      m.statusApplied
        ? t('receivedMovedNotice', {
            number: m.number,
            status: te(`shipment_${m.statusApplied}`),
          })
        : t('receivedNotice', { number: m.number }),
    );
  }

  function onRelease(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const body: GoodsReleaseRequest = {
      warehouseId: field(f, 'warehouseId'),
      packages: Number.parseInt(field(f, 'packages'), 10),
      weightKg: field(f, 'weightKg').trim() || null,
      partyName: field(f, 'partyName').trim() || null,
      note: field(f, 'note').trim() || null,
      occurredAt: toIso(field(f, 'occurredAt')),
    };
    void submit('releases', body, (m) => t('releasedNotice', { number: m.number }));
  }

  async function onPhoto(event: ChangeEvent<HTMLInputElement>, movementId: string) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_DOCUMENT_BYTES) {
      setNotice({ ok: false, text: t('photoTooLarge') });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await uploadPhoto(shipmentId, movementId, file);
      setNotice({ ok: true, text: t('photoAdded') });
      load();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setNotice({
        ok: false,
        text:
          status === 413 ? t('photoTooLarge') : status === 400 ? t('photoRejected') : failure(e),
      });
    } finally {
      setBusy(false);
    }
  }

  const cancelButton = (
    <button type="button" onClick={() => setForm(null)}>
      {tc('back')}
    </button>
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('section')}</h2>
        <div className="actions">
          {actions.canReceive && (
            <button
              type="button"
              className="primary"
              disabled={activeWarehouses.length === 0}
              onClick={() => setForm('receipt')}
            >
              {t('receive')}
            </button>
          )}
          {actions.canRelease && (
            <button type="button" onClick={() => setForm('release')}>
              {t('release')}
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        <Notice notice={notice} />
        {actions.canReceive && activeWarehouses.length === 0 && (
          <p className="muted">{t('noWarehouses')}</p>
        )}
        <p className="muted">{t('expected', { packages: data.expectedPackages })}</p>

        {form === 'receipt' && selectedWarehouse && (
          <form className="card stack" onSubmit={onReceive}>
            <h3>{t('receiptTitle')}</h3>
            <div className="grid">
              <label className="field">
                <span>{t('warehouse')}</span>
                <select
                  name="warehouseId"
                  required
                  value={selectedWarehouse.id}
                  onChange={(e) => setReceiptWarehouse(e.target.value)}
                >
                  {activeWarehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} · {localName(w)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('storageLocation')}</span>
                <select name="storageLocationId" defaultValue="" key={selectedWarehouse.id}>
                  <option value="">—</option>
                  {selectedWarehouse.storageLocations
                    .filter((l) => l.isActive)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.code}
                        {l.name ? ` · ${l.name}` : ''}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>{t('packages')}</span>
                <input name="packages" type="number" required min={1} step={1} dir="ltr" />
              </label>
              <label className="field">
                <span>{t('weightKg')}</span>
                <input name="weightKg" inputMode="decimal" dir="ltr" pattern={WEIGHT_PATTERN} />
              </label>
              <label className="field">
                <span>{t('condition')}</span>
                <select name="condition" required defaultValue="GOOD">
                  {GOODS_CONDITIONS.map((c) => (
                    <option key={c} value={c}>
                      {te(`condition_${c}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('deliveredBy')}</span>
                <input name="partyName" maxLength={200} />
              </label>
              <label className="field">
                <span>{t('occurredAt')}</span>
                <input name="occurredAt" type="datetime-local" />
              </label>
              {actions.receiptStatuses.length > 0 && (
                <label className="field">
                  <span>{t('shipmentStatus')}</span>
                  <select name="shipmentStatus" defaultValue={actions.defaultReceiptStatus ?? ''}>
                    <option value="">{t('keepStatus')}</option>
                    {actions.receiptStatuses.map((s) => (
                      <option key={s} value={s}>
                        {te(`shipment_${s}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <label className="field">
              <span>{t('note')}</span>
              <textarea name="note" maxLength={1000} />
            </label>
            <p className="muted">{t('photosHint')}</p>
            <div className="actions">
              <button type="submit" className="primary" disabled={busy}>
                {t('issueGrn')}
              </button>
              {cancelButton}
            </div>
          </form>
        )}

        {form === 'release' && held.length > 0 && (
          <form className="card stack" onSubmit={onRelease}>
            <h3>{t('releaseTitle')}</h3>
            <div className="grid">
              <label className="field">
                <span>{t('warehouse')}</span>
                <select name="warehouseId" required>
                  {held.map((b) => (
                    <option key={b.warehouseId} value={b.warehouseId}>
                      {t('heldIn', {
                        warehouse: `${b.warehouseCode} · ${localName(b)}`,
                        packages: b.onHandPackages,
                      })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('packages')}</span>
                <input
                  name="packages"
                  type="number"
                  required
                  min={1}
                  step={1}
                  dir="ltr"
                  value={releasePackages}
                  onChange={(e) => setReleasePackages(e.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('weightKg')}</span>
                <input name="weightKg" inputMode="decimal" dir="ltr" pattern={WEIGHT_PATTERN} />
              </label>
              <label className="field">
                <span>{t('collectedBy')}</span>
                <input name="partyName" maxLength={200} />
              </label>
              <label className="field">
                <span>{t('occurredAt')}</span>
                <input name="occurredAt" type="datetime-local" />
              </label>
            </div>
            <label className="field">
              <span>{t('note')}</span>
              <textarea name="note" maxLength={1000} />
            </label>
            <p className="muted">{t('releaseHint')}</p>
            <div className="actions">
              <button type="submit" className="primary" disabled={busy}>
                {t('issueRelease')}
              </button>
              {held.length === 1 && held[0] && (
                <button
                  type="button"
                  onClick={() => setReleasePackages(String(held[0]?.onHandPackages ?? ''))}
                >
                  {t('releaseAll')}
                </button>
              )}
              {cancelButton}
            </div>
          </form>
        )}
      </div>

      {data.balances.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('warehouse')}</th>
              <th>{t('received')}</th>
              <th>{t('released')}</th>
              <th>{t('onHand')}</th>
              <th>{t('receivedWeight')}</th>
            </tr>
          </thead>
          <tbody>
            {data.balances.map((b) => (
              <tr key={b.warehouseId}>
                <td>
                  <span dir="ltr">{b.warehouseCode}</span>
                  <div className="muted">{localName(b)}</div>
                </td>
                <td>{b.receivedPackages}</td>
                <td>{b.releasedPackages}</td>
                <td>
                  <strong>{b.onHandPackages}</strong>
                </td>
                <td dir="ltr">{b.receivedWeightKg}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="panel-body">{t('log')}</h3>
      {data.movements.length === 0 ? (
        <p className="empty">{t('noMovements')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('number')}</th>
              <th>{t('occurredAt')}</th>
              <th>{t('warehouse')}</th>
              <th>{t('packages')}</th>
              <th>{t('weightKg')}</th>
              <th>{t('details')}</th>
              <th>{t('photos')}</th>
            </tr>
          </thead>
          <tbody>
            {[...data.movements].reverse().map((m) => (
              <tr key={m.id}>
                <td>
                  <span dir="ltr" className="nowrap">
                    {m.number}
                  </span>
                  <div>
                    <span className={`badge badge-movement badge-${m.kind}`}>
                      {te(`movement_${m.kind}`)}
                    </span>
                  </div>
                  <PrintLink
                    href={`/shipments/${shipmentId}/movements/${m.id}`}
                    label={tp('printNote')}
                    small
                  />
                </td>
                <td>
                  {dateTime.format(new Date(m.occurredAt))}
                  <div className="muted">{m.createdByName}</div>
                </td>
                <td dir="ltr">
                  {m.warehouseCode}
                  {m.storageLocationCode ? ` / ${m.storageLocationCode}` : ''}
                </td>
                <td dir="ltr">{m.kind === 'RELEASE' ? `−${m.packages}` : `+${m.packages}`}</td>
                <td dir="ltr">{m.weightKg ?? '—'}</td>
                <td>
                  {m.condition && <div>{te(`condition_${m.condition}`)}</div>}
                  {m.partyName && (
                    <div className="muted">
                      {m.kind === 'RECEIPT' ? t('deliveredBy') : t('collectedBy')}: {m.partyName}
                    </div>
                  )}
                  {m.statusApplied && <StatusBadge kind="shipment" status={m.statusApplied} />}
                  {m.note && <div className="pre">{m.note}</div>}
                </td>
                <td>
                  <div className="stack tight">
                    {m.photos.map((p) => (
                      <a
                        key={p.documentId}
                        href={`/api/v1/shipments/${shipmentId}/documents/${p.documentId}/file`}
                      >
                        {p.fileName}
                      </a>
                    ))}
                    {actions.canAddPhotos && (
                      <label className="button small">
                        {t('addPhoto')}
                        <input
                          type="file"
                          className="visually-hidden"
                          accept="image/jpeg,image/png,image/webp"
                          disabled={busy}
                          onChange={(e) => void onPhoto(e, m.id)}
                        />
                      </label>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
