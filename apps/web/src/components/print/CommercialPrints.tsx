'use client';

import type { BookingDto, CustomerDto, QuotationDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLocalName, useLocationName, useMasterData } from '@/lib/master-data';
import { Money, useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';
import {
  DocFields,
  DocSection,
  DocumentSheet,
  PageStyle,
  PrintPending,
  PrintToolbar,
  SignatureBoxes,
} from './PrintKit';

/** The customer's card, when the user may see customers (as on the screens); else null. */
export function useCustomer(customerId: string | null): CustomerDto | null {
  const me = useMe();
  const allowed = can(me, 'customers:view');
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  useEffect(() => {
    if (!customerId || !allowed) return;
    let cancelled = false;
    api<CustomerDto>(`/customers/${customerId}`)
      .then((c) => {
        if (!cancelled) setCustomer(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [customerId, allowed]);
  return customer?.id === customerId ? customer : null;
}

/** The customer block of a printout: name, number, contact and address from the card. */
export function CustomerBlock({ name, customer }: { name: string; customer: CustomerDto | null }) {
  const t = useTranslations('Print');
  return (
    <div className="doc-party">
      <span className="muted">{t('billTo')}</span>
      <strong>{customer?.companyName ?? name}</strong>
      {customer?.companyName && customer.companyName !== name && <span>{name}</span>}
      {customer && (
        <>
          <span dir="ltr">{customer.number}</span>
          {(customer.address || customer.city) && (
            <span>
              {[customer.address, customer.city, customer.countryCode].filter(Boolean).join(' · ')}
            </span>
          )}
          <span dir="ltr">{[customer.phone, customer.email].filter(Boolean).join(' · ')}</span>
          {customer.taxNumber && (
            <span>
              {t('taxNumber')}: <span dir="ltr">{customer.taxNumber}</span>
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** A party (shipper, consignee, notify) of the customer by id: name, company, phone, address. */
export function PartyText({ customer, id }: { customer: CustomerDto | null; id: string | null }) {
  if (!id) return <>—</>;
  const party = customer?.parties.find((p) => p.id === id);
  if (!party) return <>…</>;
  return (
    <>
      {party.companyName ? `${party.name} (${party.companyName})` : party.name}
      {party.phone && (
        <>
          {' · '}
          <span dir="ltr">{party.phone}</span>
        </>
      )}
      {(party.address || party.city) && (
        <div className="muted">{[party.address, party.city].filter(Boolean).join(' · ')}</div>
      )}
    </>
  );
}

export function QuotationPrint({ id }: { id: string }) {
  const t = useTranslations('Quotations');
  const tp = useTranslations('Print');
  const te = useTranslations('Enums');
  const master = useMasterData();
  const name = useLocalName();
  const locationName = useLocationName(master);
  const { record: q, notice } = useRecord<QuotationDto>(`/quotations/${id}`);
  const customer = useCustomer(q?.customerId ?? null);
  if (!q) return <PrintPending notice={notice} />;
  const chargeName = (code: string) => {
    const charge = master?.chargeTypes.find((c) => c.code === code);
    return charge ? name(charge) : code;
  };
  const watermark =
    q.status === 'DRAFT' || q.status === 'REJECTED' || q.status === 'EXPIRED'
      ? te(`quotation_${q.status}`)
      : null;
  return (
    <>
      <PageStyle />
      <PrintToolbar back={`/quotations/${id}`} ready={master !== null} />
      <DocumentSheet
        title={tp('quotationTitle')}
        number={q.number}
        date={<span dir="ltr">{q.createdAt.slice(0, 10)}</span>}
        branchId={q.branchId}
        watermark={watermark}
      >
        <div className="doc-columns">
          <CustomerBlock name={q.customerName} customer={customer} />
          <DocFields
            fields={[
              [t('validUntil'), <span dir="ltr">{q.validUntil}</span>],
              [t('currency'), <span dir="ltr">{q.currency}</span>],
              [tp('status'), te(`quotation_${q.status}`)],
            ]}
          />
        </div>
        <DocSection title={tp('shipmentDetails')}>
          <DocFields
            fields={[
              [t('origin'), locationName(q.originLocationId)],
              [t('destination'), locationName(q.destinationLocationId)],
              [t('mode'), te(`mode_${q.mode}`)],
              [t('loadType'), q.loadType],
              [t('cargoType'), te(`cargo_${q.cargoType}`)],
              [t('cargoDescription'), q.cargoDescription],
            ]}
          />
        </DocSection>
        <DocSection title={t('lines')}>
          <table className="doc-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('chargeType')}</th>
                <th>{t('unit')}</th>
                <th className="num">{t('quantity')}</th>
                <th className="num">{t('unitPrice')}</th>
                <th className="num">{t('discount')}</th>
                <th className="num">{t('lineTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {q.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td>{l.lineNo}</td>
                  <td>
                    {chargeName(l.chargeTypeCode)}
                    {l.description && <div className="muted">{l.description}</div>}
                  </td>
                  <td>{te(`unit_${l.unit}`)}</td>
                  <td className="num" dir="ltr">
                    {l.quantity}
                  </td>
                  <td className="num">
                    <Money value={l.unitPrice} />
                  </td>
                  <td className="num">
                    <Money value={l.discount} />
                  </td>
                  <td className="num">
                    <Money value={l.lineTotal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="doc-totals">
            <dt>{t('subtotal')}</dt>
            <dd>
              <Money value={q.subtotal} currency={q.currency} />
            </dd>
            <dt>{t('discountTotal')}</dt>
            <dd>
              <Money value={q.discountTotal} currency={q.currency} />
            </dd>
            <dt className="grand">{t('total')}</dt>
            <dd className="grand">
              <Money value={q.total} currency={q.currency} />
            </dd>
          </dl>
        </DocSection>
        {q.terms && (
          <DocSection title={t('terms')}>
            <p className="pre">{q.terms}</p>
          </DocSection>
        )}
        <SignatureBoxes labels={[tp('signForNolon'), tp('signCustomerAcceptance')]} />
      </DocumentSheet>
    </>
  );
}

export function BookingPrint({ id }: { id: string }) {
  const t = useTranslations('Bookings');
  const tp = useTranslations('Print');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const { record: b, notice } = useRecord<BookingDto>(`/bookings/${id}`);
  const customer = useCustomer(b?.customerId ?? null);
  if (!b) return <PrintPending notice={notice} />;
  const list = new Intl.ListFormat(locale);
  const watermark =
    b.status === 'DRAFT' || b.status === 'CANCELLED' ? te(`booking_${b.status}`) : null;
  return (
    <>
      <PageStyle />
      <PrintToolbar back={`/bookings/${id}`} ready={master !== null} />
      <DocumentSheet
        title={tp('bookingTitle')}
        number={b.number}
        date={<span dir="ltr">{(b.confirmedAt ?? b.createdAt).slice(0, 10)}</span>}
        branchId={b.branchId}
        watermark={watermark}
      >
        <div className="doc-columns">
          <CustomerBlock name={b.customerName} customer={customer} />
          <DocFields
            fields={[
              [tp('status'), te(`booking_${b.status}`)],
              [tp('shipmentNumber'), b.shipmentNumber && <span dir="ltr">{b.shipmentNumber}</span>],
              [
                t('requestedDeparture'),
                b.requestedDeparture && <span dir="ltr">{b.requestedDeparture}</span>,
              ],
            ]}
          />
        </div>
        <DocSection title={tp('shipmentDetails')}>
          <DocFields
            fields={[
              [t('origin'), locationName(b.originLocationId)],
              [t('destination'), locationName(b.destinationLocationId)],
              [t('mode'), te(`mode_${b.mode}`)],
              [t('loadType'), b.loadType],
              [t('cargoType'), te(`cargo_${b.cargoType}`)],
              [t('services'), list.format(b.services.map((s) => te(`service_${s}`)))],
              [t('cargoDescription'), b.cargoDescription],
            ]}
          />
        </DocSection>
        <DocSection title={tp('parties')}>
          <DocFields
            fields={[
              [t('shipperId'), <PartyText customer={customer} id={b.shipperId} />],
              [t('consigneeId'), <PartyText customer={customer} id={b.consigneeId} />],
              [t('notifyPartyId'), <PartyText customer={customer} id={b.notifyPartyId} />],
            ]}
          />
        </DocSection>
        <DocSection title={t('items')}>
          <ItemsTable items={b.items} />
        </DocSection>
        {b.specialInstructions && (
          <DocSection title={t('specialInstructions')}>
            <p className="pre">{b.specialInstructions}</p>
          </DocSection>
        )}
        <p className="muted">{tp('bookingNote')}</p>
        <SignatureBoxes labels={[tp('signForNolon'), tp('signCustomer')]} />
      </DocumentSheet>
    </>
  );
}

/** Cargo lines of a booking or shipment. */
export function ItemsTable({
  items,
}: {
  items: readonly {
    lineNo: number;
    cargoType: string;
    containerTypeCode: string | null;
    description: string | null;
    quantity: number;
    lengthCm: string | null;
    widthCm: string | null;
    heightCm: string | null;
    weightKg: string | null;
    volumeCbm: string | null;
  }[];
}) {
  const t = useTranslations('Bookings');
  const te = useTranslations('Enums');
  return (
    <table className="doc-table">
      <thead>
        <tr>
          <th>#</th>
          <th>{t('cargoType')}</th>
          <th>{t('itemDescription')}</th>
          <th className="num">{t('quantity')}</th>
          <th className="num">{t('dimensions')}</th>
          <th className="num">{t('weightKg')}</th>
          <th className="num">{t('volumeCbm')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.lineNo}>
            <td>{i.lineNo}</td>
            <td>
              {te(`cargo_${i.cargoType}`)}
              {i.containerTypeCode && <span dir="ltr"> · {i.containerTypeCode}</span>}
            </td>
            <td>{i.description ?? '—'}</td>
            <td className="num" dir="ltr">
              {i.quantity}
            </td>
            <td className="num" dir="ltr">
              {i.lengthCm && i.widthCm && i.heightCm
                ? `${i.lengthCm} × ${i.widthCm} × ${i.heightCm}`
                : '—'}
            </td>
            <td className="num" dir="ltr">
              {i.weightKg ?? '—'}
            </td>
            <td className="num" dir="ltr">
              {i.volumeCbm ?? '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
