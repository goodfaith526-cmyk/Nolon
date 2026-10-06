'use client';

import {
  SUPPLIER_BILL_LINE_KINDS,
  type BillableConsolidationDto,
  type BillableTripDto,
  type CreateSupplierBillRequest,
  type ExpenseCategoryDto,
  type Page,
  type ShipmentSummaryDto,
  type SupplierBillDto,
  type SupplierBillInput,
  type SupplierBillLineInput,
  type SupplierBillLineKind,
  type SupplierSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN, FX_RATE_PATTERN, todayString } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useApiList } from '../finance/reports/ReportKit';
import { useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';

interface LineDraft {
  key: number;
  kind: SupplierBillLineKind;
  chargeTypeCode: string;
  /** The shipment's number as typed; resolved to its id on save. */
  shipmentNumber: string;
  tripId: string;
  consolidationId: string;
  expenseCategoryCode: string;
  description: string;
  amount: string;
}

let nextKey = 1;
const emptyLine = (kind: SupplierBillLineKind = 'EXPENSE'): LineDraft => ({
  key: nextKey++,
  kind,
  chargeTypeCode: '',
  shipmentNumber: '',
  tripId: '',
  consolidationId: '',
  expenseCategoryCode: '',
  description: '',
  amount: '',
});

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
  const [currency, setCurrency] = useState(bill?.currency ?? 'USD');
  const [trips, setTrips] = useState<BillableTripDto[]>([]);
  const [containers, setContainers] = useState<BillableConsolidationDto[]>([]);
  const categories = useApiList<ExpenseCategoryDto>('/accounting/expense-categories', true);
  const [lines, setLines] = useState<LineDraft[]>(() =>
    bill
      ? bill.lines.map((l) => ({
          key: nextKey++,
          kind: l.kind,
          chargeTypeCode: l.chargeTypeCode ?? '',
          shipmentNumber: l.shipmentNumber ?? '',
          tripId: l.tripId ?? '',
          consolidationId: l.consolidationId ?? '',
          expenseCategoryCode: l.expenseCategoryCode ?? '',
          description: l.description ?? '',
          amount: l.amount,
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

  /** The shipment id for a typed number (exact match among those the user may see). */
  async function shipmentId(number: string): Promise<string | null> {
    const page = await api<Page<ShipmentSummaryDto>>(
      `/shipments?pageSize=5&q=${encodeURIComponent(number)}`,
    );
    return page.items.find((s) => s.number === number)?.id ?? null;
  }

  async function toInput(l: LineDraft, index: number): Promise<SupplierBillLineInput> {
    const base = { kind: l.kind, description: l.description.trim() || null, amount: l.amount };
    if (l.kind === 'SHIPMENT_COST') {
      const number = l.shipmentNumber.trim();
      const found = number ? await shipmentId(number) : null;
      if (!found) throw new LineError(t('shipmentNotFound', { line: index + 1 }));
      return { ...base, shipmentId: found, chargeTypeCode: l.chargeTypeCode };
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
        billDate: field(form, 'billDate'),
        dueDate: field(form, 'dueDate'),
        notes: field(form, 'notes').trim() || null,
        lines: await Promise.all(lines.map((l, i) => toInput(l, i))),
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
          <select value={branchId} required onChange={(e) => setBranchId(e.target.value)}>
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
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
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
            name="fxRate"
            inputMode="decimal"
            dir="ltr"
            pattern={FX_RATE_PATTERN}
            disabled={currency === 'USD'}
            defaultValue={bill && bill.currency !== 'USD' ? bill.fxRate : ''}
          />
        </label>
        <label className="field">
          {t('billDate')}
          <input
            name="billDate"
            type="date"
            required
            defaultValue={bill?.billDate ?? todayString()}
          />
        </label>
        <label className="field">
          {t('dueDate')}
          <input
            name="dueDate"
            type="date"
            required
            defaultValue={bill?.dueDate ?? todayString()}
          />
        </label>
      </div>

      <fieldset className="stack">
        <legend>{t('lines')}</legend>
        <p className="muted">{t('linesHint')}</p>
        {lines.map((l, index) => (
          <div key={l.key} className="card grid">
            <label className="field">
              {t('lineKind')} {index + 1}
              <select
                value={l.kind}
                onChange={(e) => update(l.key, { kind: e.target.value as SupplierBillLineKind })}
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
                <label className="field">
                  {t('shipmentNumber')}
                  <input
                    required
                    dir="ltr"
                    value={l.shipmentNumber}
                    onChange={(e) => update(l.key, { shipmentNumber: e.target.value })}
                  />
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
                <select
                  required
                  value={l.tripId}
                  onChange={(e) => update(l.key, { tripId: e.target.value })}
                >
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
                onChange={(e) => update(l.key, { amount: e.target.value })}
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
