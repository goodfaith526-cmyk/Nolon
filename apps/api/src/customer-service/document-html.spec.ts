import { describe, expect, it } from 'vitest';
import {
  type ReceiptData,
  type WaybillData,
  maskPhone,
  receiptHtml,
  waybillHtml,
} from './document-html.js';

const evil = '<script>alert(1)</script>';

const waybill: WaybillData = {
  number: 'BK00050',
  bookingNumber: 'BK00050',
  receivedAt: '2026-11-06T09:00:00.000Z',
  receivedPlace: { ar: `نافذة السوق ${evil}`, en: 'Market window' },
  origin: { ar: 'بورتسودان', en: 'Port Sudan' },
  destination: { ar: 'الخرطوم', en: 'Khartoum' },
  mode: 'ROAD',
  services: ['MAIN_FREIGHT'],
  sender: { name: `عبدالرحيم ${evil}`, phone: '+249912000651' },
  receiver: { name: 'Consignee', phone: '0912345678', city: 'Khartoum' },
  items: [{ cargoType: 'BARREL', description: evil, quantity: 4, weightKg: '20', volumeCbm: null }],
  received: { packages: 4, weightKg: '20', volumeCbm: null },
  trackingQrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
};

const receipt: ReceiptData = {
  number: 'NOL-RC-2026-000005',
  receiptDate: '2026-11-06',
  amount: '600',
  currency: 'SAR',
  reference: evil,
  customerName: `شركة ${evil}`,
  bookingNumber: 'BK00050',
  shipmentNumber: 'BK00050',
  place: { name: { ar: 'نافذة السوق', en: 'Market window' }, outlet: 'Outlet' },
  invoices: [{ number: 'NOL-INV-2026-000012', amount: '600' }],
};

describe('waybill and receipt documents (plan 13-5)', () => {
  it('escapes every value, holds no http URL and runs no script', () => {
    for (const html of [
      waybillHtml(waybill, 'ar'),
      waybillHtml(waybill, 'en'),
      receiptHtml(receipt, 'ar'),
      receiptHtml(receipt, 'en'),
    ]) {
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toMatch(/https?:\/\//);
    }
  });

  it('is right to left in Arabic, and the waybill has no price and masks phones', () => {
    const ar = waybillHtml(waybill, 'ar');
    expect(ar).toContain('dir="rtl"');
    expect(waybillHtml(waybill, 'en')).toContain('dir="ltr"');
    expect(ar).toContain('بوليصة الشحن');
    expect(ar).not.toContain('+249912000651');
    expect(ar).toContain(maskPhone('+249912000651')!);
    // No currency anywhere in the text (the embedded font and logo set aside).
    expect(ar.replace(/data:[^"')]+/g, '')).not.toMatch(/USD|SAR|SDG/);
    const r = receiptHtml(receipt, 'ar');
    expect(r).toContain('NOL-RC-2026-000005');
    expect(r).toContain('600 SAR');
    expect(r).toContain('NOL-INV-2026-000012');
  });

  it('masks the middle of a phone', () => {
    expect(maskPhone('+249912000651')).toBe('+249••••••651');
    expect(maskPhone('12345')).toBe('•••••');
    expect(maskPhone(null)).toBeNull();
  });
});
