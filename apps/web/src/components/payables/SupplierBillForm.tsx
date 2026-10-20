'use client';

import {
  SUPPLIER_BILL_LINE_KINDS,
  type BillableConsolidationDto,
  type BillableTripDto,
  type CreateSupplierBillRequest,
  type ExpenseCategoryDto,
  type Page,
  type SupplierBillDto,
  type SupplierBillInput,
  type SupplierBillLineInput,
  type SupplierBillLineKind,
  type SupplierDto,
  type SupplierSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { branchCurrency, branchToday } from '@/lib/branches';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN, FX_RATE_PATTERN } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useApiList } from '../finance/reports/ReportKit';
import { useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { type PickedShipment, ShipmentPicker } from './ShipmentPicker';

interface LineDraft {
  key: number;
  kind: SupplierBillLineKind;
  chargeTypeCode: string;
  /** The shipment picked from the list (functional review C10). */
  shipment: PickedShipment | null;
  tripId: string;
  consolidationId: string;
  expenseCategoryCode: string;
  description: string;
  amount: string;
  /**
   * The agreed cost a picked trip put in `amount` (functional review C2), with that trip and its
   * currency; null once the person typed an amount, or for any other line.
   */
  copied: { tripId: string; currency: string; amount: string } | null;
}

let nextKey = 1;
const emptyLine = (kind: SupplierBillLineKind = 'EXPENSE'): LineDraft => ({
  key: nextKey++,
  kind,
  chargeTypeCode: '',
  shipment: null,
  tripId: '',
  consolidationId: '',
  expenseCategoryCode: '',
  description: '',
  amount: '',
  copied: null,
});

/**
 * A line without the amount a trip copied into it, when the person has not changed that amount
 * (C2): used when the line's trip, kind or the bill's currency changes. A typed amount is kept.
 */
function dropCopied(line: LineDraft): LineDraft {
  if (!line.copied) return line;
  return line.amount === line.copied.amount
    ? { ...line, amount: '', copied: null }
    : { ...line, copied: null };
}

/** New bill (no id) or a draft's edit page. The API checks every amount, date and reference. */
export function SupplierBillForm({ id }: { id?: string }) {
  return id ? <EditBill id={id} /> : <BillForm bill={null} />;
}

function EditBill({ id }: { id: string }) {
  const tc = useTranslations('Common');
  const { record: bill, notice } = useRecord<SupplierBillDto>(`/supplier-bills/${id}`);
  if (!bill) return notice ? <Notice notice={notice} /> : <p className="muted">{tc('loading')}</p>;
  return <BillForm bill={bill} />;
}

function BillForm({ bill }: { bill: SupplierBillDto | null }) {
  const t = useTranslations('SupplierBills');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<SupplierSummaryDto[] | null>(null);
  const [supplierId, setSupplierId] = useState(bill?.supplierId ?? '');
  const [branchId, setBranchId] = useState(bill?.branchId ?? me.branches[0]?.id ?? '');
  // A new bill's currency is its branch's (functional review C2, C4), read from /auth/me and
  // following the branch until the person picks one or types an amount (null until then). A
  // carrier's trips may be in several currencies, so none of them is taken: the form offers each.
  const [currencyChoice, setCurrencyChoice] = useState<string | null>(bill?.currency ?? null);
  const currency = currencyChoice ?? branchCurrency(me, branchId);
  // A new bill is dated today in its branch (C9), following the branch until a date is typed.
  const [billDateChoice, setBillDate] = useState<string | null>(bill?.billDate ?? null);
  const billDate = billDateChoice ?? branchToday(me, branchId);
  // Left empty, the API makes the due date the bill date plus the supplier's payment terms when
  // the bill is saved (C1); a date the person enters is sent and kept.
  const [dueDate, setDueDate] = useState(bill?.dueDate ?? '');
  const [termsDays, setTermsDays] = useState<number | null>(null);
  const [trips, setTrips] = useState<BillableTripDto[]>([]);
  const [containers, setContainers] = useState<BillableConsolidationDto[]>([]);
  const categories = useApiList<ExpenseCategoryDto>('/accounting/expense-categories', true);
  const [lines, setLines] = useState<LineDraft[]>(() =>
    bill
      ? bill.lines.map((l) => ({
          key: nextKey++,
          kind: l.kind,
          chargeTypeCode: l.chargeTypeCode ?? '',
          shipment: l.shipmentId ? { id: l.shipmentId, number: l.shipmentNumber ?? '' } : null,
          tripId: l.tripId ?? '',
          consolidationId: l.consolidationId ?? '',
          expenseCategoryCode: l.expenseCategoryCode ?? '',
          description: l.description ?? '',
          amount: l.amount,
          copied: null,
        }))
      : [emptyLine()],
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    if (bill) return;
    api<Page<SupplierSummaryDto>>('/suppliers?activeOnly=true&pageSize=100')
      .then((page) => setSuppliers(page.items))
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [bill, failure]);

  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    api<SupplierDto>(`/suppliers/${supplierId}`)
      .then((s) => {
        if (!cancelled) setTermsDays(s.paymentTermsDays);
      })
      .catch(() => {
        // Without the terms the hint names no number of days; the API still applies them.
      });
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  useEffect(() => {
    if (!supplierId || !branchId || !can(me, 'transport_trips:view')) return;
    let cancelled = false;
    api<BillableTripDto[]>(`/suppliers/${supplierId}/billable-trips?branchId=${branchId}`)
      .then((list) => {
        if (!cancelled) setTrips(list);
      })
      .catch(() => {
        // Without the list, trip lines offer only the trips already on the bill.
      });
    return () => {
      cancelled = true;
    };
  }, [supplierId, branchId, me]);

  useEffect(() => {
    if (!branchId || !can(me, 'suppliers:create')) return;
    let cancelled = false;
    api<BillableConsolidationDto[]>(`/consolidations/billable?branchId=${branchId}`)
      .then((list) => {
        if (!cancelled) setContainers(list);
      })
      .catch(() => {
        // Without the list, container lines offer only the containers already on the bill.
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, me]);

  if (!can(me, bill ? 'suppliers:update' : 'suppliers:create')) {
    return <p className="error">{tc('noAccess')}</p>;
  }
  if (!master) return <p className="muted">{tc('loading')}</p>;

  const tripChoices = [
    ...(bill?.lines ?? []).flatMap((l) =>
      l.tripId ? [{ tripId: l.tripId, label: l.tripNumber ?? l.tripId }] : [],
    ),
    ...trips
      .filter((tr) => tr.currency === currency)
      .map((tr) => ({
        tripId: tr.tripId,
        label: `${tr.tripNumber} · ${tr.carrierName} · ${tr.agreedCost} ${tr.currency}`,
      })),
  ].filter((c, i, all) => all.findIndex((x) => x.tripId === c.tripId) === i);

  const containerChoices = [
    ...(bill?.lines ?? []).flatMap((l) =>
      l.consolidationId
        ? [{ id: l.consolidationId, label: l.consolidationNumber ?? l.consolidationId }]
        : [],
    ),
    ...containers.map((c) => ({
      id: c.id,
      label: `${c.number}${c.containerNumber ? ` · ${c.containerNumber}` : ''} · ${te(
        `consolidation_${c.status}`,
      )}`,
    })),
  ].filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i);

  const update = (key: number, patch: Partial<LineDraft>) =>
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // Billable trips of the supplier in currencies other than the bill's, offered as a choice of
  // currency (C2): never one taken on the person's behalf.
  const otherCurrencies = [
    ...trips
      .filter((tr) => tr.currency !== currency)
      .reduce(
        (counts, tr) => counts.set(tr.currency, (counts.get(tr.currency) ?? 0) + 1),
        new Map<string, number>(),
      ),
  ];

  /**
   * Another currency for the bill. Amounts trips copied in are dropped (they were in the old
   * currency), unless the person changed them, and trips of another currency are unpicked (C2).
   */
  function linesIn(next: string) {
    setLines((all) =>
      all.map((l) => {
        const trip = trips.find((tr) => tr.tripId === l.tripId);
        const unpicked = trip && trip.currency !== next ? { ...l, tripId: '' } : l;
        return l.copied && l.copied.currency !== next ? dropCopied(unpicked) : unpicked;
      }),
    );
  }

  function changeCurrency(next: string) {
    setCurrencyChoice(next);
    linesIn(next);
  }

  /** Another branch; a currency that follows the branch changes with it (see `currency`). */
  function changeBranch(next: string) {
    setBranchId(next);
    if (currencyChoice === null) linesIn(branchCurrency(me, next));
  }

  /**
   * A trip picked on a line puts its agreed cost, in its currency, in the amount (C2), unless the
   * person typed an amount; the amount stays editable. Another trip, or none, drops a copied
   * amount the person did not change, and copies the new trip's.
   */
  function pickTrip(line: LineDraft, tripId: string) {
    const trip = trips.find((tr) => tr.tripId === tripId);
    const cleared = dropCopied(line);
    const copy = trip && trip.currency === currency && cleared.amount === '';
    update(line.key, {
      tripId,
      amount: copy ? trip.agreedCost : cleared.amount,
      copied: copy ? { tripId, currency: trip.currency, amount: trip.agreedCost } : null,
    });
  }

  function toInput(l: LineDraft, index: number): SupplierBillLineInput {
    const base = { kind: l.kind, description: l.description.trim() || null, amount: l.amount };
    if (l.kind === 'SHIPMENT_COST') {
      if (!l.shipment) throw new LineError(t('chooseShipmentFirst', { line: index + 1 }));
      return { ...base, shipmentId: l.shipment.id, chargeTypeCode: l.chargeTypeCode };
    }
    if (l.kind === 'TRIP') return { ...base, tripId: l.tripId };
    if (l.kind === 'CONSOLIDATION') {
      return { ...base, consolidationId: l.consolidationId, chargeTypeCode: l.chargeTypeCode };
    }
    return { ...base, expenseCategoryCode: l.expenseCategoryCode };
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fxRate = field(form, 'fxRate').trim();
    setBusy(true);
    setNotice(null);
    try {
      const input: SupplierBillInput = {
        branchId,
        supplierReference: field(form, 'supplierReference').trim() || null,
        currency,
        fxRate: currency === 'USD' || fxRate === '' ? null : fxRate,
        billDate,
        dueDate: dueDate || null,
        notes: field(form, 'notes').trim() || null,
        lines: lines.map((l, i) => toInput(l, i)),
      };
      if (bill) {
        await api<SupplierBillDto>(`/supplier-bills/${bill.id}`, { method: 'PATCH', body: input });
        router.push(`/supplier-bills/${bill.id}`);
      } else {
        const body: CreateSupplierBillRequest = {
          ...input,
          requestId: crypto.randomUUID(),
          supplierId,
        };
        const saved = await api<SupplierBillDto>('/supplier-bills', { method: 'POST', body });
        router.push(`/supplier-bills/${saved.id}`);
      }
    } catch (err) {
      setNotice({ ok: false, text: err instanceof LineError ? err.message : failure(err) });
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <h1>{bill ? t('editTitle') : t('add')}</h1>
      <Notice notice={notice} />
      <div className="grid">
        <label className="field">
          {t('supplier')}
          {bill ? (
            <input value={bill.supplierName} disabled />
          ) : (
            <select value={supplierId} required onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">{t('chooseSupplier')}</option>
              {(suppliers ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="field">
          {t('branch')}
          <select value={branchId} required onChange={(e) => changeBranch(e.target.value)}>
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {name(b)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('supplierReference')}
          <input
            name="supplierReference"
            maxLength={50}
            dir="ltr"
            defaultValue={bill?.supplierReference ?? ''}
          />
        </label>
        <label className="field">
          {t('currency')}
          <select value={currency} required onChange={(e) => changeCurrency(e.target.value)}>
            {master.currencies
              .filter((c) => c.isActive)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {name(c)}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          {t('fxRateOptional')}
          <input
            // Only a rate the user entered is sent back: otherwise the FX table's rate for the
            // date applies again. A changed currency starts empty.
            key={currency}
            name="fxRate"
            inputMode="decimal"
            dir="ltr"
            pattern={FX_RATE_PATTERN}
            disabled={currency === 'USD'}
            defaultValue={currency === bill?.currency ? (bill.enteredFxRate ?? '') : ''}
          />
        </label>
        <label className="field">
          {t('billDate')}
          <input
            name="billDate"
            type="date"
            required
            value={billDate}
            onChange={(e) => setBillDate(e.target.value)}
          />
        </label>
        <label className="field">
          {t('dueDateOptional')}
          <input
            name="dueDate"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          {dueDate === '' && (
            <span className="muted">
              {termsDays === null
                ? t('dueDateFromTermsUnknown')
                : t('dueDateFromTerms', { days: termsDays })}
            </span>
          )}
        </label>
      </div>
      {otherCurrencies.length > 0 && (
        <div className="row">
          <span className="muted">{t('tripsInOtherCurrencies')}</span>
          {otherCurrencies.map(([code, count]) => (
            <button key={code} type="button" onClick={() => changeCurrency(code)}>
              {t('useTripCurrency', { currency: code, count })}
            </button>
          ))}
        </div>
      )}

      <fieldset className="stack">
        <legend>{t('lines')}</legend>
        <p className="muted">{t('linesHint')}</p>
        {lines.map((l, index) => (
          <div key={l.key} className="card grid">
            <label className="field">
              {t('lineKind')} {index + 1}
              <select
                value={l.kind}
                onChange={(e) =>
                  update(l.key, {
                    ...dropCopied(l),
                    kind: e.target.value as SupplierBillLineKind,
                  })
                }
              >
                {SUPPLIER_BILL_LINE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {te(`billLineKind_${k}`)}
                  </option>
                ))}
              </select>
            </label>
            {l.kind === 'SHIPMENT_COST' && (
              <>
                <div className="field">
                  {t('shipmentNumber')}
                  <ShipmentPicker
                    branchId={branchId}
                    value={l.shipment}
                    onChange={(shipment) => update(l.key, { shipment })}
                  />
                </div>
                <label className="field">
                  {t('chargeType')}
                  <select
                    required
                    value={l.chargeTypeCode}
                    onChange={(e) => update(l.key, { chargeTypeCode: e.target.value })}
                  >
                    <option value="">{t('chooseChargeType')}</option>
                    {master.chargeTypes.map((c) => (
                      <option key={c.code} value={c.code}>
                        {name(c)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {l.kind === 'CONSOLIDATION' && (
              <>
                <label className="field">
                  {t('consolidation')}
                  <select
                    required
                    value={l.consolidationId}
                    onChange={(e) => update(l.key, { consolidationId: e.target.value })}
                  >
                    <option value="">{t('chooseConsolidation')}</option>
                    {containerChoices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  {t('chargeType')}
                  <select
                    required
                    value={l.chargeTypeCode}
                    onChange={(e) => update(l.key, { chargeTypeCode: e.target.value })}
                  >
                    <option value="">{t('chooseChargeType')}</option>
                    {master.chargeTypes.map((c) => (
                      <option key={c.code} value={c.code}>
                        {name(c)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {l.kind === 'TRIP' && (
              <label className="field">
                {t('trip')}
                <select required value={l.tripId} onChange={(e) => pickTrip(l, e.target.value)}>
                  <option value="">{t('chooseTrip')}</option>
                  {tripChoices.map((c) => (
                    <option key={c.tripId} value={c.tripId}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {l.kind === 'EXPENSE' && (
              <label className="field">
                {t('expenseCategory')}
                <select
                  required
                  value={l.expenseCategoryCode}
                  onChange={(e) => update(l.key, { expenseCategoryCode: e.target.value })}
                >
                  <option value="">{t('chooseCategory')}</option>
                  {(categories ?? [])
                    .filter((c) => c.isActive)
                    .map((c) => (
                      <option key={c.code} value={c.code}>
                        {name(c)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label className="field">
              {t('description')}
              <input
                maxLength={500}
                value={l.description}
                onChange={(e) => update(l.key, { description: e.target.value })}
              />
            </label>
            <label className="field">
              {t('amount', { currency })}
              <input
                required
                inputMode="decimal"
                dir="ltr"
                pattern={AMOUNT_PATTERN}
                value={l.amount}
                onChange={(e) => {
                  update(l.key, { amount: e.target.value, copied: null });
                  // A typed amount is in the currency shown then: another branch no longer
                  // changes it (Codex F94-2).
                  if (currencyChoice === null) setCurrencyChoice(currency);
                }}
              />
            </label>
            {lines.length > 1 && (
              <div className="actions">
                <button
                  type="button"
                  onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}
                >
                  {tc('remove')}
                </button>
              </div>
            )}
          </div>
        ))}
        <div className="actions">
          <button type="button" onClick={() => setLines((all) => [...all, emptyLine()])}>
            {t('addLine')}
          </button>
        </div>
      </fieldset>

      <label className="field">
        {tc('notes')}
        <textarea name="notes" maxLength={2000} defaultValue={bill?.notes ?? ''} />
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || (!bill && supplierId === '')}>
          {t('save')}
        </button>
        <button type="button" onClick={() => router.back()}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}

/** A line the form could not send (a shipment number that matches nothing). */
class LineError extends Error {}
