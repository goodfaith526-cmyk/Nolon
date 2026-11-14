'use client';

import type {
  ConsolidationSummaryDto,
  Page,
  PalletDto,
  ShipmentSummaryDto,
  TripSummaryDto,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { ReasonForm, useRecord } from '../finance/common';
import { useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { CarrierLabel } from './common';

type Panel = 'container' | 'trip' | 'cancel' | null;

/**
 * Plan 15-3: one pallet. The API decides every button (`actions`); the page only calls it and
 * shows the refusal in the page language.
 */
export function PalletDetail({ id }: { id: string }) {
  const t = useTranslations('Pallets');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const me = useMe();
  const failure = useFailureText();
  const { record: pallet, notice: loadNotice, setRecord } = useRecord<PalletDto>(`/pallets/${id}`);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const onError = useCallback(
    (e: unknown) => setNotice({ ok: false, text: failure(e) }),
    [failure],
  );

  if (!me.palletsEnabled) return <p className="error">{tc('noAccess')}</p>;
  if (!pallet) return <Notice notice={loadNotice} />;

  async function act(path: string, method: 'POST' | 'DELETE' = 'POST', body?: object) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(await api<PalletDto>(`/pallets/${id}${path}`, { method, body }));
      setPanel(null);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  const a = pallet.actions;
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1 dir="ltr">{pallet.number}</h1>
          <p className="muted">
            {locale === 'ar' ? pallet.warehouseName.ar : pallet.warehouseName.en} · {t('createdBy')}
            : {pallet.createdByName}
          </p>
        </div>
        <div className="actions">
          <StatusBadge kind="pallet" status={pallet.status} />
          <Link href={`/print/pallets/${pallet.id}`} className="button">
            {t('printLabel')}
          </Link>
          <Link href="/pallets" className="button">
            {t('back')}
          </Link>
        </div>
      </div>
      <Notice notice={notice} />
      {pallet.carrier && (
        <p>
          {t('carrier')}: <CarrierLabel carrier={pallet.carrier} />
        </p>
      )}
      {pallet.cancelReason && (
        <p className="muted">{t('cancelledReason', { reason: pallet.cancelReason })}</p>
      )}

      <div className="actions">
        {a.close && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act('/close')}
          >
            {t('close')}
          </button>
        )}
        {a.putInContainer && (
          <button type="button" disabled={busy} onClick={() => setPanel('container')}>
            {t('putInContainer')}
          </button>
        )}
        {a.putOnTrip && (
          <button type="button" disabled={busy} onClick={() => setPanel('trip')}>
            {t('putOnTrip')}
          </button>
        )}
        {a.takeOut && (
          <button type="button" disabled={busy} onClick={() => void act('/take-out')}>
            {t('takeOut')}
          </button>
        )}
        {a.unpack && (
          <button
            type="button"
            disabled={busy}
            title={t('unpackHint')}
            onClick={() => void act('/unpack')}
          >
            {t('unpack')}
          </button>
        )}
        {a.cancel && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => setPanel('cancel')}
          >
            {t('cancel')}
          </button>
        )}
      </div>
      {a.close && <p className="muted">{t('closeHint')}</p>}

      {panel === 'container' && (
        <CarrierChooser
          kind="container"
          busy={busy}
          onBack={() => setPanel(null)}
          onError={onError}
          onChoose={(carrierId) => void act('/container', 'POST', { consolidationId: carrierId })}
        />
      )}
      {panel === 'trip' && (
        <CarrierChooser
          kind="trip"
          busy={busy}
          onBack={() => setPanel(null)}
          onError={onError}
          onChoose={(carrierId) => void act('/trip', 'POST', { tripId: carrierId })}
        />
      )}
      {panel === 'cancel' && (
        <ReasonForm
          hint={t('cancelHint')}
          label={t('cancelReason')}
          submitLabel={t('cancel')}
          backLabel={t('back')}
          busy={busy}
          onSubmit={(reason) => void act('/cancel', 'POST', { reason })}
          onBack={() => setPanel(null)}
        />
      )}

      <h2>{t('shipments')}</h2>
      {pallet.shipments.length === 0 ? (
        <p className="empty">{t('noShipments')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('shipment')}</th>
                <th>{t('customer')}</th>
                <th>{tc('status')}</th>
                {a.addShipments && <th />}
              </tr>
            </thead>
            <tbody>
              {pallet.shipments.map((s) => (
                <tr key={s.shipmentId}>
                  <td dir="ltr">
                    <Link href={`/shipments/${s.shipmentId}`}>{s.number}</Link>
                  </td>
                  <td>{s.customerName}</td>
                  <td>
                    <StatusBadge kind="shipment" status={s.status} />
                  </td>
                  {a.addShipments && (
                    <td>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(`/shipments/${s.shipmentId}`, 'DELETE')}
                      >
                        {t('remove')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {a.addShipments && (
        <ShipmentSearch
          exclude={pallet.shipments.map((s) => s.shipmentId)}
          busy={busy}
          onError={onError}
          onPick={(shipmentId) => void act('/shipments', 'POST', { shipmentId })}
        />
      )}
    </section>
  );
}

/** Search the user's shipments to add one; the API checks branch, status and other pallets. */
function ShipmentSearch({
  exclude,
  busy,
  onPick,
  onError,
}: {
  exclude: readonly string[];
  busy: boolean;
  onPick: (shipmentId: string) => void;
  onError: (e: unknown) => void;
}) {
  const t = useTranslations('Pallets');
  const tc = useTranslations('Common');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ShipmentSummaryDto[] | null>(null);

  async function search() {
    try {
      const page = await api<Page<ShipmentSummaryDto>>(
        `/shipments?pageSize=20&q=${encodeURIComponent(q)}`,
      );
      setResults(page.items);
    } catch (e) {
      onError(e);
    }
  }

  const shown = (results ?? []).filter((s) => !exclude.includes(s.id));
  return (
    <div className="card stack">
      <h3>{t('addShipment')}</h3>
      <div className="line">
        <label className="field grow">
          <span>{t('shipmentSearch')}</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void search();
              }
            }}
          />
        </label>
        <button type="button" onClick={() => void search()}>
          {tc('search')}
        </button>
      </div>
      {results !== null &&
        (shown.length === 0 ? (
          <p className="muted">{t('searchNoResults')}</p>
        ) : (
          <ul className="picker">
            {shown.map((s) => (
              <li key={s.id}>
                <button type="button" disabled={busy} onClick={() => onPick(s.id)}>
                  <span dir="ltr">{s.number}</span>
                  <span>{s.customerName}</span>
                  <StatusBadge kind="shipment" status={s.status} />
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/** Pick an open container or a planned trip of the user's branches. */
function CarrierChooser({
  kind,
  busy,
  onChoose,
  onBack,
  onError,
}: {
  kind: 'container' | 'trip';
  busy: boolean;
  onChoose: (id: string) => void;
  onBack: () => void;
  onError: (e: unknown) => void;
}) {
  const t = useTranslations('Pallets');
  const [options, setOptions] = useState<{ id: string; number: string }[] | null>(null);
  const [chosen, setChosen] = useState('');

  useEffect(() => {
    const path =
      kind === 'container'
        ? '/consolidations?pageSize=100&status=OPEN'
        : '/trips?pageSize=100&status=PLANNED';
    api<Page<ConsolidationSummaryDto | TripSummaryDto>>(path)
      .then((page) => setOptions(page.items.map((c) => ({ id: c.id, number: c.number }))))
      .catch(onError);
  }, [kind, onError]);

  return (
    <form
      className="card row"
      onSubmit={(e) => {
        e.preventDefault();
        onChoose(chosen);
      }}
    >
      {options !== null && options.length === 0 ? (
        <p className="muted">{kind === 'container' ? t('noContainers') : t('noTrips')}</p>
      ) : (
        <label className="field grow">
          <span>{kind === 'container' ? t('chooseContainer') : t('chooseTrip')}</span>
          <select required value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="" />
            {(options ?? []).map((o) => (
              <option key={o.id} value={o.id} dir="ltr">
                {o.number}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className="primary" disabled={busy || !chosen}>
        {kind === 'container' ? t('putInContainer') : t('putOnTrip')}
      </button>
      <button type="button" onClick={onBack}>
        {t('back')}
      </button>
    </form>
  );
}
