import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CsStatementDto } from '@nolon/shared';

export type StatementLang = 'ar' | 'en';

/** Every text that reaches the HTML goes through this (plan 09 section 7: escape before HTML). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ASSETS = join(import.meta.dirname, '..', '..', 'assets', 'statement');

let cached: { fonts: string; logo: Record<StatementLang, string> } | null = null;

/** The font (IBM Plex Sans Arabic, OFL, as the web app) and NOLON's logo, as data URIs. */
function assets(): { fonts: string; logo: Record<StatementLang, string> } {
  if (cached) return cached;
  const data = (file: string, type: string) =>
    `data:${type};base64,${readFileSync(join(ASSETS, file)).toString('base64')}`;
  const face = (subset: 'arabic' | 'latin', weight: 400 | 700) =>
    `@font-face{font-family:'Plex';font-weight:${weight};src:url(${data(
      `ibm-plex-sans-arabic-${subset}-${weight}-normal.woff2`,
      'font/woff2',
    )}) format('woff2');}`;
  cached = {
    fonts: [face('arabic', 400), face('arabic', 700), face('latin', 400), face('latin', 700)].join(
      '',
    ),
    logo: { ar: data('logo-ar.webp', 'image/webp'), en: data('logo-en.webp', 'image/webp') },
  };
  return cached;
}

const TEXT = {
  ar: {
    title: 'كشف حساب',
    customer: 'العميل',
    period: 'الفترة',
    generated: 'تاريخ الإصدار',
    requests: 'طلبات الحجز',
    bookings: 'الحجوزات والشحنات',
    invoices: 'الفواتير',
    totals: 'الإجماليات',
    ref: 'الرقم',
    date: 'التاريخ',
    route: 'من / إلى',
    goods: 'البضاعة',
    status: 'الحالة',
    booking: 'الحجز',
    shipment: 'الشحنة',
    stage: 'المرحلة',
    delivered: 'التسليم',
    due: 'الاستحقاق',
    currency: 'العملة',
    count: 'العدد',
    total: 'الإجمالي',
    paid: 'المدفوع',
    credited: 'الإشعارات الدائنة',
    balance: 'المتبقي',
    none: 'لا يوجد',
    cut: (shown: number, all: number) =>
      `يعرض أحدث ${shown} من ${all}؛ الإجماليات تشمل الـ ${all} كلها. اطلب فترة أقصر لعرض الباقي.`,
    footer: 'نولون للخدمات اللوجستية. هذا الكشف للعلم ولا يغني عن الفواتير والإيصالات الرسمية.',
  },
  en: {
    title: 'Statement',
    customer: 'Customer',
    period: 'Period',
    generated: 'Generated',
    requests: 'Booking requests',
    bookings: 'Bookings and shipments',
    invoices: 'Invoices',
    totals: 'Totals',
    ref: 'Number',
    date: 'Date',
    route: 'From / to',
    goods: 'Goods',
    status: 'Status',
    booking: 'Booking',
    shipment: 'Shipment',
    stage: 'Stage',
    delivered: 'Delivered',
    due: 'Due',
    currency: 'Currency',
    count: 'Count',
    total: 'Total',
    paid: 'Paid',
    credited: 'Credited',
    balance: 'Balance',
    none: 'None',
    cut: (shown: number, all: number) =>
      `Showing the latest ${shown} of ${all}; totals cover all ${all}. Ask for a shorter period for the rest.`,
    footer:
      'NOLON Logistics. This statement is for information and does not replace official invoices and receipts.',
  },
} as const;

const REQUEST_STATUS: Record<string, { ar: string; en: string }> = {
  awaiting_routing: { ar: 'قيد التوجيه', en: 'Being routed' },
  pending: { ar: 'قيد المراجعة', en: 'Under review' },
  estimated: { ar: 'بانتظار موافقتك على التقدير', en: 'Estimate awaiting you' },
  approved: { ar: 'مقبول', en: 'Approved' },
  rejected: { ar: 'مرفوض', en: 'Rejected' },
  expired: { ar: 'منتهي الصلاحية', en: 'Expired' },
  cancelled: { ar: 'ملغي', en: 'Cancelled' },
};

const BOOKING_STATUS: Record<string, { ar: string; en: string }> = {
  DRAFT: { ar: 'مسودة', en: 'Draft' },
  CONFIRMED: { ar: 'مؤكد', en: 'Confirmed' },
  COMPLETED: { ar: 'مكتمل', en: 'Completed' },
  CANCELLED: { ar: 'ملغي', en: 'Cancelled' },
};

const day = (iso: string) => iso.slice(0, 10);

/**
 * The statement as self-contained HTML (A4, RTL for Arabic): no external URL, no script; every
 * value escaped. An authorized person's statement (invoices null) has no invoice section at all.
 */
export function statementHtml(s: CsStatementDto, lang: StatementLang): string {
  const t = TEXT[lang];
  const e = escapeHtml;
  const arrow = lang === 'ar' ? '←' : '→';
  const pick = (v: { ar: string; en: string } | null | undefined) => (v ? e(v[lang]) : '—');
  const label = (map: Record<string, { ar: string; en: string }>, code: string) =>
    e(map[code]?.[lang] ?? code);
  const table = (head: string[], rows: string[][], numeric: number[] = []) =>
    rows.length === 0
      ? `<p class="none">${e(t.none)}</p>`
      : `<table><thead><tr>${head.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows
          .map(
            (r) =>
              `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`,
          )
          .join('')}</tbody></table>`;
  const cut = (section: { rows: unknown[]; count: number; truncated: boolean }) =>
    section.truncated ? `<p class="cut">${e(t.cut(section.rows.length, section.count))}</p>` : '';

  const requests = table(
    [t.ref, t.date, t.route, t.goods, t.status, t.booking],
    s.requests.rows.map((r) => [
      e(r.reference),
      e(day(r.createdAt)),
      `${pick(r.origin)} ${arrow} ${pick(r.destination)}`,
      `${pick(r.goods.category)} × ${e(r.goods.quantity)}`,
      label(REQUEST_STATUS, r.status),
      r.bookingNumber ? e(r.bookingNumber) : '—',
    ]),
  );
  const bookings = table(
    [t.booking, t.date, t.route, t.goods, t.status, t.shipment, t.stage, t.delivered],
    s.bookings.rows.map((b) => [
      e(b.number),
      e(day(b.createdAt)),
      `${pick(b.origin)} ${arrow} ${pick(b.destination)}`,
      b.cargoDescription ? e(b.cargoDescription) : '—',
      label(BOOKING_STATUS, b.status),
      b.shipment ? e(b.shipment.number) : '—',
      b.shipment?.stage ? e(b.shipment.stage[lang]) : '—',
      b.shipment?.deliveredAt ? e(day(b.shipment.deliveredAt)) : '—',
    ]),
  );
  const invoices = s.invoices
    ? `<h2>${e(t.invoices)}</h2>${cut(s.invoices)}${table(
        [t.ref, t.shipment, t.date, t.due, t.currency, t.total, t.paid, t.credited, t.balance],
        s.invoices.rows.map((i) => [
          e(i.number),
          i.shipmentNumber ? e(i.shipmentNumber) : '—',
          e(i.invoiceDate),
          e(i.dueDate),
          e(i.currency),
          e(i.total),
          e(i.paid),
          e(i.credited),
          e(i.balance),
        ]),
        [5, 6, 7, 8],
      )}<h2>${e(t.totals)}</h2>${table(
        [t.currency, t.count, t.total, t.paid, t.credited, t.balance],
        s.invoices.totals.map((x) => [
          e(x.currency),
          e(String(x.count)),
          e(x.total),
          e(x.paid),
          e(x.credited),
          e(x.balance),
        ]),
        [1, 2, 3, 4, 5],
      )}`
    : '';
  const a = assets();
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${e(
    t.title,
  )}</title><style>${a.fonts}
@page{size:A4;margin:14mm 12mm}
body{font-family:'Plex',sans-serif;font-size:9.5pt;color:#1a1a1a;margin:0}
header{display:flex;justify-content:space-between;align-items:center;border-block-end:2px solid #0b3d6b;padding-block-end:8px;margin-block-end:10px}
header img{height:46px}
h1{font-size:16pt;margin:0;color:#0b3d6b}
h2{font-size:11pt;margin-block:14px 6px;color:#0b3d6b}
.meta{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin-block-end:6px}
.meta b{font-weight:700}
table{width:100%;border-collapse:collapse;page-break-inside:auto}
tr{page-break-inside:avoid}
th,td{border:1px solid #c9d3dd;padding:3px 5px;text-align:start;vertical-align:top}
th{background:#eef3f8;font-weight:700}
td.num{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}
.none{color:#666}
.cut{background:#fff6e0;border:1px solid #e6c36a;padding:4px 6px}
footer{margin-block-start:16px;font-size:8pt;color:#555;border-block-start:1px solid #c9d3dd;padding-block-start:6px}
</style></head><body><header><h1>${e(t.title)}</h1><img alt="NOLON" src="${a.logo[lang]}"></header>
<div class="meta"><b>${e(t.customer)}</b><span>${e(s.customer.number)} — ${e(s.customer.label)}</span>
<b>${e(t.period)}</b><span>${e(s.period.from)} — ${e(s.period.to)}</span>
<b>${e(t.generated)}</b><span>${e(s.generatedAt.slice(0, 16).replace('T', ' '))} UTC</span></div>
<h2>${e(t.requests)}</h2>${cut(s.requests)}${requests}
<h2>${e(t.bookings)}</h2>${cut(s.bookings)}${bookings}
${invoices}
<footer>${e(t.footer)}</footer></body></html>`;
}
