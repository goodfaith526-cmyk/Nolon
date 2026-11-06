import { assets, escapeHtml, type StatementLang } from './statement-html.js';

/**
 * Plan 13-5 (owner, 2026-11-06): the two documents the customer gets for what they hand over at
 * the window, the waybill for the parcel and a receipt for the fees, as self-contained HTML (A4,
 * RTL for Arabic) for the PDF renderer: no external URL, no script, every value escaped (plan 09
 * section 7). The waybill carries no price; phones are shown masked.
 */

export type DocumentLang = StatementLang;
type Named = { ar: string; en: string };

export interface WaybillData {
  /** The waybill's number is the shipment's. */
  number: string;
  bookingNumber: string;
  /** When the goods were first received (ISO). */
  receivedAt: string;
  receivedPlace: Named | null;
  origin: Named;
  destination: Named;
  mode: string;
  services: string[];
  sender: { name: string; phone: string | null };
  receiver: { name: string; phone: string | null; city: string | null } | null;
  items: {
    cargoType: string;
    description: string | null;
    quantity: number;
    weightKg: string | null;
    volumeCbm: string | null;
  }[];
  /** What the receipts counted: packages, and weight and volume where measured. */
  received: { packages: number; weightKg: string | null; volumeCbm: string | null };
  /** The public tracking link's QR code as an SVG document, or null. */
  trackingQrSvg: string | null;
}

export interface ReceiptData {
  number: string;
  receiptDate: string;
  amount: string;
  currency: string;
  reference: string | null;
  customerName: string;
  bookingNumber: string | null;
  shipmentNumber: string | null;
  /** Where the money was taken (the window and its outlet), or null at NOLON's office. */
  place: { name: Named; outlet: string | null } | null;
  invoices: { number: string; amount: string }[];
}

const MODE: Record<string, Named> = {
  SEA: { ar: 'بحري', en: 'Sea' },
  ROAD: { ar: 'بري', en: 'Road' },
  SEA_ROAD: { ar: 'بحري وبري', en: 'Sea and road' },
};
const CARGO: Record<string, Named> = {
  CONTAINER: { ar: 'حاويات', en: 'Containers' },
  PALLET: { ar: 'طبالي', en: 'Pallets' },
  BARREL: { ar: 'براميل', en: 'Barrels' },
  GENERAL: { ar: 'بضائع عامة', en: 'General cargo' },
};
const SERVICE: Record<string, Named> = {
  MAIN_FREIGHT: { ar: 'الشحن الرئيسي', en: 'Main freight' },
  PICKUP: { ar: 'الاستلام من العميل', en: 'Pickup' },
  WAREHOUSE: { ar: 'المستودع', en: 'Warehouse' },
  CUSTOMS: { ar: 'التخليص الجمركي', en: 'Customs clearance' },
  INLAND_TRANSPORT: { ar: 'النقل الداخلي', en: 'Inland transport' },
  LAST_MILE: { ar: 'التوصيل لباب المستلم', en: 'Last-mile delivery' },
};

const TEXT = {
  ar: {
    waybill: 'بوليصة الشحن',
    receipt: 'إيصال استلام نقدية',
    number: 'الرقم',
    booking: 'رقم الحجز',
    shipment: 'رقم الشحنة',
    receivedAt: 'تاريخ الاستلام',
    place: 'مكان الاستلام',
    route: 'من / إلى',
    mode: 'طريقة الشحن',
    services: 'الخدمات',
    sender: 'المرسل',
    receiver: 'المستلم',
    phone: 'الهاتف',
    city: 'المدينة',
    goods: 'البضاعة',
    type: 'النوع',
    description: 'الوصف',
    quantity: 'العدد',
    weight: 'الوزن (كجم)',
    volume: 'الحجم (م³)',
    receivedGoods: 'ما تم استلامه',
    packages: 'عدد الطرود',
    track: 'تتبع الشحنة',
    date: 'التاريخ',
    customer: 'استلمنا من',
    amount: 'المبلغ',
    reference: 'المرجع',
    paidFor: 'سداد الفواتير',
    invoice: 'الفاتورة',
    none: '—',
    waybillFooter:
      'نولون للخدمات اللوجستية. هذه البوليصة إثبات استلام الطرود المذكورة للشحن، ولا تتضمن أسعاراً.',
    receiptFooter: 'نولون للخدمات اللوجستية. هذا الإيصال إثبات استلام المبلغ المذكور.',
  },
  en: {
    waybill: 'Waybill',
    receipt: 'Cash receipt',
    number: 'Number',
    booking: 'Booking',
    shipment: 'Shipment',
    receivedAt: 'Received',
    place: 'Received at',
    route: 'From / to',
    mode: 'Mode',
    services: 'Services',
    sender: 'Sender',
    receiver: 'Receiver',
    phone: 'Phone',
    city: 'City',
    goods: 'Goods',
    type: 'Type',
    description: 'Description',
    quantity: 'Quantity',
    weight: 'Weight (kg)',
    volume: 'Volume (m³)',
    receivedGoods: 'Received',
    packages: 'Packages',
    track: 'Track the shipment',
    date: 'Date',
    customer: 'Received from',
    amount: 'Amount',
    reference: 'Reference',
    paidFor: 'Paid towards',
    invoice: 'Invoice',
    none: '—',
    waybillFooter:
      'NOLON Logistics. This waybill proves the packages above were received for shipping; it carries no prices.',
    receiptFooter: 'NOLON Logistics. This receipt proves the amount above was received.',
  },
} as const;

/** A phone with its middle hidden: the first 4 and the last 3 characters stay. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const p = phone.trim();
  if (p.length <= 7) return '•'.repeat(p.length);
  return `${p.slice(0, 4)}${'•'.repeat(p.length - 7)}${p.slice(-3)}`;
}

const day = (iso: string) => iso.slice(0, 10);

function page(lang: DocumentLang, title: string, body: string, footer: string): string {
  const a = assets();
  const e = escapeHtml;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${e(
    title,
  )}</title><style>${a.fonts}
@page{size:A4;margin:14mm 12mm}
body{font-family:'Plex',sans-serif;font-size:10pt;color:#1a1a1a;margin:0}
header{display:flex;justify-content:space-between;align-items:center;border-block-end:2px solid #0b3d6b;padding-block-end:8px;margin-block-end:10px}
header img{height:46px}
h1{font-size:16pt;margin:0;color:#0b3d6b}
h2{font-size:11pt;margin-block:14px 6px;color:#0b3d6b}
.meta{display:grid;grid-template-columns:auto 1fr;gap:3px 12px}
.meta b{font-weight:700}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.box{border:1px solid #c9d3dd;padding:6px 8px}
.qr{display:flex;align-items:center;gap:10px;margin-block-start:12px}
.qr img{width:110px;height:110px}
.big{font-size:14pt;font-weight:700}
table{width:100%;border-collapse:collapse}
tr{page-break-inside:avoid}
th,td{border:1px solid #c9d3dd;padding:3px 5px;text-align:start;vertical-align:top}
th{background:#eef3f8;font-weight:700}
td.num,span.num{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap;direction:ltr;unicode-bidi:embed}
footer{margin-block-start:16px;font-size:8pt;color:#555;border-block-start:1px solid #c9d3dd;padding-block-start:6px}
</style></head><body><header><h1>${e(title)}</h1><img alt="NOLON" src="${a.logo[lang]}"></header>
${body}
<footer>${e(footer)}</footer></body></html>`;
}

const ltr = (v: string) => `<span class="num">${escapeHtml(v)}</span>`;

export function waybillHtml(w: WaybillData, lang: DocumentLang): string {
  const t = TEXT[lang];
  const e = escapeHtml;
  const name = (v: Named | undefined, code: string) => e(v?.[lang] ?? code);
  const arrow = lang === 'ar' ? '←' : '→';
  const party = (
    title: string,
    p: { name: string; phone: string | null; city?: string | null } | null,
  ) =>
    `<div class="box"><b>${e(title)}</b><div class="meta"><span>${e(p?.name ?? t.none)}</span><span></span>${
      p?.phone ? `<span>${e(t.phone)}</span>${ltr(maskPhone(p.phone) ?? '')}` : ''
    }${p?.city ? `<span>${e(t.city)}</span><span>${e(p.city)}</span>` : ''}</div></div>`;
  const items = w.items
    .map(
      (i) =>
        `<tr><td>${name(CARGO[i.cargoType], i.cargoType)}</td><td>${e(i.description ?? t.none)}</td><td class="num">${e(
          String(i.quantity),
        )}</td><td class="num">${e(i.weightKg ?? t.none)}</td><td class="num">${e(i.volumeCbm ?? t.none)}</td></tr>`,
    )
    .join('');
  const qr = w.trackingQrSvg
    ? `<div class="qr"><img alt="" src="data:image/svg+xml;base64,${Buffer.from(
        w.trackingQrSvg,
        'utf8',
      ).toString('base64')}"><span>${e(t.track)}</span></div>`
    : '';
  const body = `<div class="meta">
<b>${e(t.number)}</b><span class="big">${ltr(w.number)}</span>
<b>${e(t.booking)}</b>${ltr(w.bookingNumber)}
<b>${e(t.receivedAt)}</b>${ltr(day(w.receivedAt))}
${w.receivedPlace ? `<b>${e(t.place)}</b><span>${e(w.receivedPlace[lang])}</span>` : ''}
<b>${e(t.route)}</b><span>${e(w.origin[lang])} ${arrow} ${e(w.destination[lang])}</span>
<b>${e(t.mode)}</b><span>${name(MODE[w.mode], w.mode)}</span>
<b>${e(t.services)}</b><span>${w.services.map((s) => name(SERVICE[s], s)).join('، ')}</span>
</div>
<h2>${e(t.sender)} / ${e(t.receiver)}</h2>
<div class="cols">${party(t.sender, w.sender)}${party(t.receiver, w.receiver)}</div>
<h2>${e(t.goods)}</h2>
<table><thead><tr><th>${e(t.type)}</th><th>${e(t.description)}</th><th>${e(t.quantity)}</th><th>${e(
    t.weight,
  )}</th><th>${e(t.volume)}</th></tr></thead><tbody>${items}</tbody></table>
<h2>${e(t.receivedGoods)}</h2>
<div class="meta"><b>${e(t.packages)}</b>${ltr(String(w.received.packages))}
${w.received.weightKg ? `<b>${e(t.weight)}</b>${ltr(w.received.weightKg)}` : ''}
${w.received.volumeCbm ? `<b>${e(t.volume)}</b>${ltr(w.received.volumeCbm)}` : ''}</div>
${qr}`;
  return page(lang, t.waybill, body, t.waybillFooter);
}

export function receiptHtml(r: ReceiptData, lang: DocumentLang): string {
  const t = TEXT[lang];
  const e = escapeHtml;
  const invoices = r.invoices
    .map(
      (i) =>
        `<tr><td>${ltr(i.number)}</td><td class="num">${e(i.amount)} ${e(r.currency)}</td></tr>`,
    )
    .join('');
  const body = `<div class="meta">
<b>${e(t.number)}</b><span class="big">${ltr(r.number)}</span>
<b>${e(t.date)}</b>${ltr(r.receiptDate)}
<b>${e(t.customer)}</b><span>${e(r.customerName)}</span>
<b>${e(t.amount)}</b><span class="big">${ltr(`${r.amount} ${r.currency}`)}</span>
${r.reference ? `<b>${e(t.reference)}</b>${ltr(r.reference)}` : ''}
${r.bookingNumber ? `<b>${e(t.booking)}</b>${ltr(r.bookingNumber)}` : ''}
${r.shipmentNumber ? `<b>${e(t.shipment)}</b>${ltr(r.shipmentNumber)}` : ''}
${
  r.place
    ? `<b>${e(t.place)}</b><span>${e(r.place.name[lang])}${r.place.outlet ? ` · ${e(r.place.outlet)}` : ''}</span>`
    : ''
}
</div>
${
  invoices
    ? `<h2>${e(t.paidFor)}</h2><table><thead><tr><th>${e(t.invoice)}</th><th>${e(t.amount)}</th></tr></thead><tbody>${invoices}</tbody></table>`
    : ''
}`;
  return page(lang, t.receipt, body, t.receiptFooter);
}
