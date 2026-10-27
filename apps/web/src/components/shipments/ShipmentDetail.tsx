'use client';

import {
  BOOKING_SERVICES,
  SHIPMENT_REASON_MIN_LENGTH,
  type BookingService,
  type CustomerDto,
  type ShipmentDto,
  type ShipmentStatus,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { earliestLocalMinute, needsFreshShipment } from '@/lib/status-history';
import { useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { ShipmentCustoms } from '../customs/ShipmentCustoms';
import { ShipmentInvoices } from '../finance/ShipmentInvoices';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { Tabs } from '../Tabs';
import { MoreMenu } from '../MoreMenu';
import { ShipmentContainersTab } from './ShipmentContainers';
import { ShipmentPods, ShipmentTrips } from '../transport/ShipmentTransport';
import { ShipmentWarehouse } from '../warehouse/ShipmentWarehouse';
import { ShipmentDocuments } from './ShipmentDocuments';
import { PrintLink } from '../print/PrintLink';

type Panel = 'status' | 'hold' | 'revert' | 'cancel' | 'edit' | null;

/** datetime-local value (local time, no zone) to an ISO timestamp with offset. */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Ready reasons for going back a status; OTHER asks for the reason in words. */
const REVERT_REASONS = ['WRONG_SHIPMENT', 'WRONG_STATUS', 'WRONG_TIME', 'OTHER'] as const;
type RevertReason = (typeof REVERT_REASONS)[number];

/** A recorded time shown apart from when it was recorded when they differ by over an hour. */
const LATE_ENTRY_MS = 60 * 60 * 1000;

export function ShipmentDetail({ id }: { id: string }) {
  const t = useTranslations('Shipments');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const tp = useTranslations('Print');
  const locale = useLocale();
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const localName = useLocalName();
  const failure = useFailureText();
  const [shipment, setShipment] = useState<ShipmentDto | null>(null);
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [nextStatus, setNextStatus] = useState<ShipmentStatus | ''>('');
  // null: the user has not picked a location, so the status's usual one is suggested.
  const [pickedLocation, setPickedLocation] = useState<string | null>(null);
  const [revertReason, setRevertReason] = useState<RevertReason>('WRONG_SHIPMENT');

  const load = useCallback(() => {
    api<ShipmentDto>(`/shipments/${id}`)
      .then((s) => {
        setShipment(s);
        if (can(me, 'customers:view')) {
          api<CustomerDto>(`/customers/${s.customerId}`)
            .then(setCustomer)
            .catch(() => undefined);
        }
      })
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [id, failure, me]);

  useEffect(load, [load]);

  if (!shipment) {
    return notice ? <Notice notice={notice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function send(path: string, body: unknown, success: string, method = 'POST') {
    setBusy(true);
    setNotice(null);
    try {
      setShipment(await api<ShipmentDto>(`/shipments/${id}${path}`, { method, body }));
      setPanel(null);
      setNotice({ ok: true, text: success });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
      // The step shown is no longer the one a revert would undo: show the shipment as it is now,
      // so the user reviews the new step and confirms again.
      if (needsFreshShipment(e)) {
        setPanel(null);
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  function openPanel(next: Panel) {
    setNextStatus('');
    setPickedLocation(null);
    setRevertReason('WRONG_SHIPMENT');
    setPanel(next);
  }

  /** The reason, trimmed, or null (with a notice) when it is too short to explain anything. */
  function reasonText(form: FormData): string | null {
    const reason = field(form, 'reason').trim();
    if (reason.length >= SHIPMENT_REASON_MIN_LENGTH) return reason;
    setNotice({ ok: false, text: t('reasonTooShort', { min: SHIPMENT_REASON_MIN_LENGTH }) });
    return null;
  }

  function onStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void send(
      '/status',
      {
        status: field(form, 'status') as ShipmentStatus,
        occurredAt: toIso(field(form, 'occurredAt')),
        locationId: field(form, 'locationId') || null,
        note: field(form, 'note') || null,
      },
      t('statusChanged'),
    );
  }

  function onReason(event: FormEvent<HTMLFormElement>, action: 'hold' | 'cancel') {
    event.preventDefault();
    const reason = reasonText(new FormData(event.currentTarget));
    if (reason === null) return;
    const messages = { hold: t('heldNotice'), cancel: t('cancelledNotice') };
    void send(`/${action}`, { reason }, messages[action]);
  }

  function onRevert(event: FormEvent<HTMLFormElement>, undoEventId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const details = field(form, 'reason').trim();
    let reason: string | null;
    if (revertReason === 'OTHER') {
      reason = reasonText(form);
    } else {
      const preset = t(`revertReason_${revertReason}`);
      reason = details ? `${preset}: ${details}` : preset;
    }
    if (reason === null) return;
    void send('/revert', { reason, undoEventId }, t('revertedNotice'));
  }

  function onEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => field(form, name) || null;
    void send(
      '',
      {
        carrierName: text('carrierName'),
        vesselName: text('vesselName'),
        voyageNumber: text('voyageNumber'),
        blNumber: text('blNumber'),
        etd: text('etd'),
        eta: text('eta'),
        services: form.getAll('services').filter((v): v is BookingService => typeof v === 'string'),
        ...(shipment?.actions.canShareBranches
          ? {
              sharedBranchIds: form
                .getAll('sharedBranchIds')
                .filter((v): v is string => typeof v === 'string'),
            }
          : {}),
      },
      t('savedNotice'),
      'PATCH',
    );
  }

  const s = shipment;
  const actions = s.actions;
  const party = (partyId: string | null) =>
    partyId ? (customer?.parties.find((p) => p.id === partyId)?.name ?? '…') : '—';
  const trackingUrl = `${window.location.origin}/track/${s.trackingToken}`;
  const activeLocations = master?.locations.filter((l) => l.isActive) ?? [];
  const list = new Intl.ListFormat(locale);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const earliestMinute = earliestLocalMinute(actions.earliestStatusTime);
  const chosenStatus = nextStatus || actions.transitions[0] || '';
  const suggested = chosenStatus ? actions.suggestedLocations[chosenStatus] : undefined;
  const chosenLocation = pickedLocation ?? suggested ?? '';

  const reasonForm = (action: 'hold' | 'cancel', label: string, submit: string) => (
    <form className="card stack" onSubmit={(e) => onReason(e, action)}>
      <label className="field">
        <span>{label}</span>
        <textarea name="reason" required minLength={SHIPMENT_REASON_MIN_LENGTH} maxLength={1000} />
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {submit}
        </button>
        <button type="button" onClick={() => setPanel(null)}>
          {tc('back')}
        </button>
      </div>
    </form>
  );

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <div className="title-row">
            <h1>
              {t('shipment')} <span dir="ltr">{s.number}</span>
            </h1>
            <StatusBadge kind="shipment" status={s.status} />
          </div>
          <p className="muted">
            {s.customerName} ·{' '}
            {tc('route', {
              from: locationName(s.originLocationId),
              to: locationName(s.destinationLocationId),
            })}
          </p>
        </div>
        <div className="actions">
          <MoreMenu>
            <Link href={`/bookings/${s.bookingId}`}>{t('openBooking')}</Link>
            <PrintLink href={`/shipments/${s.id}/labels`} label={tp('printLabels')} />
            {(actions.canHold || actions.revertTo || actions.canCancel) && <hr />}
            {actions.canHold && (
              <button type="button" onClick={() => openPanel('hold')}>
                {t('hold')}
              </button>
            )}
            {actions.revertTo && (
              <button type="button" onClick={() => openPanel('revert')}>
                {t('revert')}
              </button>
            )}
            {actions.canCancel && (
              <button type="button" className="danger" onClick={() => openPanel('cancel')}>
                {t('cancel')}
              </button>
            )}
          </MoreMenu>
          {actions.canEdit && (
            <button type="button" onClick={() => openPanel('edit')}>
              {t('editDetails')}
            </button>
          )}
          <PrintLink href={`/shipments/${s.id}`} label={tp('printShipmentSheet')} />
          {actions.transitions.length > 0 && (
            <button type="button" className="primary" onClick={() => openPanel('status')}>
              {t('changeStatus')}
            </button>
          )}
          {actions.canResume && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void send('/resume', {}, t('resumedNotice'))}
            >
              {t('resume')}
            </button>
          )}
        </div>
      </div>
      <Notice notice={notice} />

      {panel === 'status' && (
        <form className="card stack" onSubmit={onStatus}>
          <div className="grid">
            <label className="field">
              <span>{t('newStatus')}</span>
              <select
                name="status"
                required
                value={chosenStatus}
                onChange={(e) => setNextStatus(e.target.value as ShipmentStatus)}
              >
                {actions.transitions.map((next) => (
                  <option key={next} value={next}>
                    {te(`shipment_${next}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('occurredAt')}</span>
              <input name="occurredAt" type="datetime-local" min={earliestMinute} />
            </label>
            <label className="field">
              <span>{t('location')}</span>
              <select
                name="locationId"
                value={chosenLocation}
                onChange={(e) => setPickedLocation(e.target.value)}
              >
                <option value="">—</option>
                {activeLocations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {localName(l)} ({l.code})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>{t('note')}</span>
            <textarea name="note" maxLength={1000} />
          </label>
          {suggested && chosenLocation !== suggested && (
            <p className="warning">
              {t('locationNotUsual', {
                status: te(`shipment_${chosenStatus}`),
                usual: locationName(suggested),
              })}
            </p>
          )}
          <p className="muted">
            {t('occurredAtHint', {
              earliest: dateTime.format(new Date(earliestMinute)),
            })}
          </p>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setPanel(null)}>
              {tc('back')}
            </button>
          </div>
        </form>
      )}
      {panel === 'hold' && reasonForm('hold', t('holdReason'), t('hold'))}
      {panel === 'revert' && actions.revertTo && actions.revertUndoes && (
        <form
          className="card stack"
          onSubmit={(e) => onRevert(e, actions.revertUndoes?.eventId ?? '')}
        >
          <p>
            {t('revertUndoes', {
              status: te(`shipment_${actions.revertUndoes.status}`),
              user: actions.revertUndoes.userName ?? '—',
              time: dateTime.format(new Date(actions.revertUndoes.occurredAt)),
              to: te(`shipment_${actions.revertTo}`),
            })}
          </p>
          {!actions.revertUndoes.byMe && (
            <>
              <p className="warning">
                {t('revertOthersStep', { user: actions.revertUndoes.userName ?? '—' })}
              </p>
              <div className="checks">
                <label>
                  <input type="checkbox" name="confirmOthers" required />
                  {t('revertConfirmOthers')}
                </label>
              </div>
            </>
          )}
          <label className="field">
            <span>{t('revertReason')}</span>
            <select
              value={revertReason}
              onChange={(e) => setRevertReason(e.target.value as RevertReason)}
            >
              {REVERT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`revertReason_${r}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{revertReason === 'OTHER' ? t('revertReasonOther') : t('revertDetails')}</span>
            <textarea
              name="reason"
              required={revertReason === 'OTHER'}
              minLength={revertReason === 'OTHER' ? SHIPMENT_REASON_MIN_LENGTH : undefined}
              maxLength={900}
            />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t('revert')}
            </button>
            <button type="button" onClick={() => setPanel(null)}>
              {tc('back')}
            </button>
          </div>
        </form>
      )}
      {panel === 'cancel' && reasonForm('cancel', t('cancelReason'), t('cancel'))}
      {panel === 'edit' && (
        <form className="card stack" onSubmit={onEdit}>
          <div className="grid">
            {(['carrierName', 'vesselName', 'voyageNumber', 'blNumber'] as const).map((name) => (
              <label key={name} className="field">
                <span>{t(name)}</span>
                <input name={name} defaultValue={s[name] ?? ''} maxLength={200} />
              </label>
            ))}
            <label className="field">
              <span>{t('etd')}</span>
              <input name="etd" type="date" defaultValue={s.etd ?? ''} />
            </label>
            <label className="field">
              <span>{t('eta')}</span>
              <input name="eta" type="date" defaultValue={s.eta ?? ''} />
            </label>
          </div>
          <fieldset>
            <legend>{t('services')}</legend>
            <div className="checks">
              {BOOKING_SERVICES.map((service) => (
                <label key={service}>
                  <input
                    type="checkbox"
                    name="services"
                    value={service}
                    defaultChecked={s.services.includes(service)}
                  />
                  {te(`service_${service}`)}
                </label>
              ))}
            </div>
          </fieldset>
          {actions.canShareBranches && (
            <fieldset>
              <legend>{t('sharedBranches')}</legend>
              <p className="muted">{t('sharedBranchesHint')}</p>
              <div className="checks">
                {s.shareableBranches.map((b) => (
                  <label key={b.id}>
                    <input
                      type="checkbox"
                      name="sharedBranchIds"
                      value={b.id}
                      defaultChecked={s.sharedBranchIds.includes(b.id)}
                    />
                    {localName(b)} ({b.code})
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setPanel(null)}>
              {tc('back')}
            </button>
          </div>
        </form>
      )}

      <Tabs
        label={t('sections')}
        tabs={[
          {
            key: 'overview',
            label: t('tabOverview'),
            content: (
              <>
                <div className="panels">
                  <div className="panel">
                    <div className="panel-head">
                      <h2>{t('overview')}</h2>
                    </div>
                    <dl className="details flat">
                      <dt>{t('mode')}</dt>
                      <dd>
                        {te(`mode_${s.mode}`)}
                        {s.loadType ? ` · ${s.loadType}` : ''} · {te(`cargo_${s.cargoType}`)}
                      </dd>
                      <dt>{t('services')}</dt>
                      <dd>{list.format(s.services.map((x) => te(`service_${x}`)))}</dd>
                      <dt>{t('consignee')}</dt>
                      <dd>{party(s.consigneeId)}</dd>
                      <dt>{t('shipper')}</dt>
                      <dd>{party(s.shipperId)}</dd>
                      <dt>{t('sharedBranches')}</dt>
                      <dd>
                        {s.sharedBranches.length > 0
                          ? list.format(s.sharedBranches.map((b) => `${localName(b)} (${b.code})`))
                          : '—'}
                      </dd>
                      <dt>{t('currentLocation')}</dt>
                      <dd>{s.currentLocationId ? locationName(s.currentLocationId) : '—'}</dd>
                      <dt>{t('carrierName')}</dt>
                      <dd>
                        {[s.carrierName, s.vesselName, s.voyageNumber]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </dd>
                      <dt>{t('blNumber')}</dt>
                      <dd dir="ltr">{s.blNumber ?? '—'}</dd>
                      <dt>{t('etd')}</dt>
                      <dd dir="ltr">{s.etd ?? '—'}</dd>
                      <dt>{t('eta')}</dt>
                      <dd dir="ltr">{s.eta ?? '—'}</dd>
                      {s.holdReason && (
                        <>
                          <dt>{t('holdReason')}</dt>
                          <dd>{s.holdReason}</dd>
                        </>
                      )}
                      {s.cancelReason && (
                        <>
                          <dt>{t('cancelReason')}</dt>
                          <dd>{s.cancelReason}</dd>
                        </>
                      )}
                    </dl>
                  </div>
                  <div className="panel">
                    <div className="panel-head">
                      <h2>{t('publicTracking')}</h2>
                    </div>
                    <div className="tracking-share">
                      {/* The API draws the QR code of the public tracking link. */}
                      {/* eslint-disable-next-line @next/next/no-img-element -- an API-served SVG, not a static asset */}
                      <img
                        src={`/api/v1/shipments/${s.id}/qr.svg`}
                        alt={t('qrAlt')}
                        width={160}
                        height={160}
                      />
                      <div className="stack">
                        <p className="muted">{t('trackingHint')}</p>
                        <input
                          readOnly
                          dir="ltr"
                          value={trackingUrl}
                          onFocus={(e) => e.target.select()}
                        />
                        <div className="actions">
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(trackingUrl)
                                .then(() => setNotice({ ok: true, text: t('linkCopied') }));
                            }}
                          >
                            {t('copyLink')}
                          </button>
                          <a href={trackingUrl} target="_blank" rel="noreferrer" className="button">
                            {t('openPublicPage')}
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h2>{t('timeline')}</h2>
                  </div>
                  <ol className="timeline">
                    {[...s.events].reverse().map((e) => (
                      <li key={e.id} className={`timeline-item kind-${e.kind}`}>
                        <div className="timeline-head">
                          <StatusBadge kind="shipment" status={e.status} />
                          <span className="muted">{te(`eventKind_${e.kind}`)}</span>
                        </div>
                        <div className="muted">
                          {dateTime.format(new Date(e.occurredAt))}
                          {e.locationId ? ` · ${locationName(e.locationId)}` : ''}
                          {' · '}
                          {e.userName ?? te(`source_${e.source}`)}
                        </div>
                        {Math.abs(Date.parse(e.createdAt) - Date.parse(e.occurredAt)) >
                          LATE_ENTRY_MS && (
                          <div className="muted">
                            {t('recordedAt', { time: dateTime.format(new Date(e.createdAt)) })}
                          </div>
                        )}
                        {e.reason && (
                          <div>
                            <strong>{t('reason')}: </strong>
                            {e.reason}
                          </div>
                        )}
                        {e.note && <div className="pre">{e.note}</div>}
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h2>{t('items')}</h2>
                  </div>
                  <table>
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
                      {s.items.map((i) => (
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
                </div>
              </>
            ),
          },
          {
            key: 'containers',
            label: t('tabContainers'),
            content: <ShipmentContainersTab shipment={s} onChange={setShipment} />,
          },
          ...(can(me, 'transport_trips:view') || can(me, 'pod:view')
            ? [
                {
                  key: 'transport',
                  label: t('tabTransport'),
                  content: (
                    <>
                      {can(me, 'transport_trips:view') && (
                        <ShipmentTrips
                          shipmentId={s.id}
                          canPlanTrip={
                            can(me, 'transport_trips:create') &&
                            s.status !== 'CLOSED' &&
                            s.status !== 'CANCELLED'
                          }
                        />
                      )}
                      {can(me, 'pod:view') && (
                        <ShipmentPods shipment={s} onShipmentChanged={load} />
                      )}
                    </>
                  ),
                },
              ]
            : []),
          ...(can(me, 'warehouse:view')
            ? [
                {
                  key: 'warehouse',
                  label: t('tabWarehouse'),
                  content: <ShipmentWarehouse shipment={s} onShipmentChanged={load} />,
                },
              ]
            : []),
          ...(can(me, 'customs:view')
            ? [
                {
                  key: 'customs',
                  label: t('tabCustoms'),
                  content: <ShipmentCustoms shipment={s} onShipmentChange={setShipment} />,
                },
              ]
            : []),
          ...(can(me, 'documents:view')
            ? [
                {
                  key: 'documents',
                  label: t('tabDocuments'),
                  content: <ShipmentDocuments shipmentId={s.id} />,
                },
              ]
            : []),
          ...(can(me, 'customer_invoices:view')
            ? [
                {
                  key: 'invoices',
                  label: t('tabInvoices'),
                  content: <ShipmentInvoices shipmentId={s.id} />,
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}
