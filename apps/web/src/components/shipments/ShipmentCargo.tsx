'use client';

import {
  type CargoType,
  type ShipmentCargoCorrectionRequest,
  type ShipmentDto,
  type ShipmentItemDto,
  SHIPMENT_REASON_MIN_LENGTH,
  cbmOf,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { asciiDigits } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { icons } from '../Icons';
import { cargoChoices } from '../commercial/cargo';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';

interface LineState {
  key: number;
  cargoType: CargoType;
  containerTypeCode: string;
  description: string;
  quantity: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  weightKg: string;
  volumeCbm: string;
}

const MEASURES = ['lengthCm', 'widthCm', 'heightCm', 'weightKg', 'volumeCbm'] as const;

let nextKey = 1;
const lineState = (i: ShipmentItemDto): LineState => ({
  key: nextKey++,
  cargoType: i.cargoType,
  containerTypeCode: i.containerTypeCode ?? '',
  description: i.description ?? '',
  quantity: String(i.quantity),
  lengthCm: i.lengthCm ?? '',
  widthCm: i.widthCm ?? '',
  heightCm: i.heightCm ?? '',
  weightKg: i.weightKg ?? '',
  // With dimensions, the API computes the volume from them.
  volumeCbm: i.lengthCm ? '' : (i.volumeCbm ?? ''),
});
const hasDimensions = (l: LineState) => l.lengthCm !== '' || l.widthCm !== '' || l.heightCm !== '';
const orNull = (v: string) => (v.trim() === '' ? null : v.trim());
const packagesOf = (items: readonly ShipmentItemDto[]) => items.reduce((n, i) => n + i.quantity, 0);

/**
 * A shipment's cargo lines, their corrections, and the correction form (B3-3). The form sends
 * every line with the revision it was opened on and one request id per attempt, so a retry after
 * a lost answer changes nothing twice and a form opened before another correction is refused.
 */
export function ShipmentCargo({
  shipment: s,
  onChange,
}: {
  shipment: ShipmentDto;
  onChange: (shipment: ShipmentDto) => void;
}) {
  const t = useTranslations('Shipments');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const master = useMasterData();
  const name = useLocalName();
  const failure = useFailureText();
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const [editing, setEditing] = useState<{ revision: number; requestId: string } | null>(null);
  const [lines, setLines] = useState<LineState[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  function open() {
    setLines(s.items.map(lineState));
    setReason('');
    setNotice(null);
    setEditing({ revision: s.cargoRevision, requestId: crypto.randomUUID() });
  }

  const update = (key: number, patch: Partial<LineState>) =>
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const body: ShipmentCargoCorrectionRequest = {
      requestId: editing.requestId,
      expectedRevision: editing.revision,
      reason: reason.trim(),
      items: lines.map((l) => ({
        cargoType: l.cargoType,
        containerTypeCode: l.cargoType === 'CONTAINER' ? l.containerTypeCode : null,
        description: orNull(l.description),
        quantity: Number(l.quantity),
        lengthCm: orNull(l.lengthCm),
        widthCm: orNull(l.widthCm),
        heightCm: orNull(l.heightCm),
        weightKg: orNull(l.weightKg),
        volumeCbm: hasDimensions(l) ? null : orNull(l.volumeCbm),
      })),
    };
    setBusy(true);
    setNotice(null);
    try {
      onChange(await api<ShipmentDto>(`/shipments/${s.id}/items`, { method: 'PUT', body }));
      setEditing(null);
      setNotice({ ok: true, text: t('cargoCorrected') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('items')}</h2>
        {s.actions.canCorrectCargo && !editing && (
          <button type="button" className="button small" onClick={open}>
            {t('correctCargo')}
          </button>
        )}
      </div>
      {notice && <Notice notice={notice} />}
      {editing ? (
        <form className="stack" onSubmit={(e) => void submit(e)}>
          <p className="muted">{t('correctCargoHint')}</p>
          {lines.map((l, index) => (
            <div key={l.key} className="line">
              <span className="muted">{index + 1}</span>
              <label className="field">
                {t('cargo')}
                <select
                  value={l.cargoType}
                  onChange={(e) => {
                    const next = e.target.value as CargoType;
                    update(l.key, {
                      cargoType: next,
                      containerTypeCode: next === 'CONTAINER' ? '20GP' : '',
                    });
                  }}
                >
                  {cargoChoices(l.cargoType).map((c) => (
                    <option key={c} value={c}>
                      {te(`cargo_${c}`)}
                    </option>
                  ))}
                </select>
              </label>
              {l.cargoType === 'CONTAINER' && (
                <label className="field">
                  {t('containerType')}
                  <select
                    value={l.containerTypeCode}
                    onChange={(e) => update(l.key, { containerTypeCode: e.target.value })}
                  >
                    {(master?.containerTypes ?? [])
                      .filter((c) => c.isActive || c.code === l.containerTypeCode)
                      .map((c) => (
                        <option key={c.code} value={c.code}>
                          {name(c)}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label className="field">
                {t('quantity')}
                <input
                  type="number"
                  min={1}
                  required
                  value={l.quantity}
                  onChange={(e) => update(l.key, { quantity: e.target.value })}
                />
              </label>
              {MEASURES.map((k) => (
                <label key={k} className="field">
                  {t(k)}
                  <input
                    inputMode="decimal"
                    dir="ltr"
                    value={
                      k === 'volumeCbm' && hasDimensions(l)
                        ? (cbmOf(l.lengthCm, l.widthCm, l.heightCm, l.quantity) ?? '')
                        : l[k]
                    }
                    required={k !== 'weightKg' && k !== 'volumeCbm' && hasDimensions(l)}
                    disabled={k === 'volumeCbm' && hasDimensions(l)}
                    onChange={(e) => update(l.key, { [k]: asciiDigits(e.target.value) })}
                  />
                </label>
              ))}
              <label className="field">
                {t('lineDescription')}
                <input
                  value={l.description}
                  maxLength={500}
                  onChange={(e) => update(l.key, { description: e.target.value })}
                />
              </label>
              {lines.length > 1 && (
                <button
                  type="button"
                  className="ghost icon-button line-remove-button"
                  aria-label={tc('remove')}
                  title={tc('remove')}
                  onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}
                >
                  {icons.close}
                </button>
              )}
            </div>
          ))}
          <div>
            <button
              type="button"
              className="ghost add-line"
              onClick={() =>
                setLines((all) => [
                  ...all,
                  lineState({
                    lineNo: all.length + 1,
                    cargoType: all.at(-1)?.cargoType ?? 'GENERAL',
                    containerTypeCode: null,
                    description: null,
                    quantity: 1,
                    lengthCm: null,
                    widthCm: null,
                    heightCm: null,
                    weightKg: null,
                    volumeCbm: null,
                  }),
                ])
              }
            >
              {icons.plus}
              <span>{t('addCargoLine')}</span>
            </button>
          </div>
          <label className="field">
            <span>{t('cargoCorrectionReason')}</span>
            <textarea
              required
              minLength={SHIPMENT_REASON_MIN_LENGTH}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t('saveCargoCorrection')}
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              {tc('back')}
            </button>
          </div>
        </form>
      ) : (
        <ItemsTable items={s.items} />
      )}
      {s.cargoCorrections.length > 0 && (
        <details>
          <summary>
            {t('cargoCorrections')} ({s.cargoCorrections.length})
          </summary>
          <ol className="stack">
            {[...s.cargoCorrections].reverse().map((c) => (
              <li key={c.revision} className="stack tight">
                <strong>
                  {t('cargoCorrectionBy', {
                    revision: c.revision,
                    user: c.correctedByName,
                    time: dateTime.format(new Date(c.correctedAt)),
                  })}
                </strong>
                {c.containerNumber && (
                  <span className="muted">
                    {t('cargoCorrectionContainer', { container: c.containerNumber })}
                  </span>
                )}
                <div className="pre">{c.reason}</div>
                <div className="muted">
                  {t('cargoBefore')}:{' '}
                  {t('cargoLinesSummary', {
                    lines: c.itemsBefore.length,
                    packages: packagesOf(c.itemsBefore),
                  })}
                  {' · '}
                  {t('cargoAfter')}:{' '}
                  {t('cargoLinesSummary', {
                    lines: c.itemsAfter.length,
                    packages: packagesOf(c.itemsAfter),
                  })}
                </div>
                <ItemsTable items={c.itemsBefore} caption={t('cargoBefore')} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function ItemsTable({ items, caption }: { items: readonly ShipmentItemDto[]; caption?: string }) {
  const t = useTranslations('Shipments');
  const te = useTranslations('Enums');
  return (
    <table>
      {caption && <caption>{caption}</caption>}
      <thead>
        <tr>
          <th>#</th>
          <th>{t('cargo')}</th>
          <th>{t('quantity')}</th>
          <th>{t('weightKg')}</th>
          <th>{t('volumeCbm')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.lineNo}>
            <td>{i.lineNo}</td>
            <td>
              {te(`cargo_${i.cargoType}`)}
              {i.containerTypeCode ? ` · ${i.containerTypeCode}` : ''}
              {i.description ? <div className="muted">{i.description}</div> : null}
            </td>
            <td>{i.quantity}</td>
            <td dir="ltr">{i.weightKg ?? '—'}</td>
            <td dir="ltr">{i.volumeCbm ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
