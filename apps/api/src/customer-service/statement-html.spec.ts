import type { CsStatementDto } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { escapeHtml, statementHtml } from './statement-html.js';

const evil = '<script>alert(1)</script>';

function sampleStatement(over: Partial<CsStatementDto> = {}): CsStatementDto {
  return {
    customer: { number: 'CS00042', label: `شركة النيل ${evil}` },
    period: { from: '2026-05-06', to: '2026-11-06' },
    generatedAt: '2026-11-06T01:00:00.000Z',
    requests: {
      rows: [
        {
          reference: 'BK00042',
          createdAt: '2026-10-01T08:00:00.000Z',
          origin: { ar: 'دبي', en: 'Dubai' },
          destination: { ar: 'الخرطوم', en: 'Khartoum' },
          goods: { category: { ar: `عام ${evil}`, en: 'General' }, quantity: '2', unit: 'PER_CBM' },
          status: 'cancelled',
          bookingNumber: null,
        },
      ],
      count: 1,
      truncated: false,
    },
    bookings: {
      rows: [
        {
          number: 'BK00041',
          createdAt: '2026-09-01T08:00:00.000Z',
          origin: { ar: 'دبي', en: 'Dubai' },
          destination: { ar: 'بورتسودان', en: 'Port Sudan' },
          cargoDescription: `أثاث ${evil}`,
          status: 'COMPLETED',
          shipment: {
            number: 'BK00041',
            stage: { code: 'DELIVERED', ar: 'تم التسليم', en: 'Delivered', order: 9 },
            deliveredAt: '2026-10-20T10:00:00.000Z',
          },
        },
      ],
      count: 250,
      truncated: true,
    },
    invoices: {
      rows: [
        {
          number: 'NOL-INV-2026-000100',
          shipmentNumber: 'BK00041',
          invoiceDate: '2026-09-02',
          dueDate: '2026-09-30',
          currency: 'USD',
          total: '1250.5',
          paid: '1000',
          credited: '0',
          balance: '250.5',
        },
      ],
      count: 1,
      truncated: false,
      totals: [
        {
          currency: 'USD',
          count: 1,
          total: '1250.5',
          paid: '1000',
          credited: '0',
          balance: '250.5',
        },
      ],
    },
    invoicesHidden: null,
    ...over,
  };
}

describe('statement HTML (plan 14-3)', () => {
  it('escapes every customer-entered text', () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    const html = statementHtml(sampleStatement(), 'ar');
    expect(html).not.toContain(evil);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script/i);
  });

  it('is self-contained: no http(s) URL, fonts and logo as data URIs', () => {
    const html = statementHtml(sampleStatement(), 'en');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).toContain('data:image/webp;base64,');
    expect(Buffer.byteLength(html)).toBeLessThan(512 * 1024);
  });

  it('is RTL in Arabic and LTR in English', () => {
    expect(statementHtml(sampleStatement(), 'ar')).toContain('<html lang="ar" dir="rtl">');
    expect(statementHtml(sampleStatement(), 'en')).toContain('<html lang="en" dir="ltr">');
  });

  it('shows the truncation notice of a cut section', () => {
    const html = statementHtml(sampleStatement(), 'en');
    expect(html).toContain('Showing the latest 1 of 250; totals cover all 250.');
  });

  it("has no invoice section, total or count for an authorized person's statement", () => {
    const html = statementHtml(
      sampleStatement({ invoices: null, invoicesHidden: 'CONTACT' }),
      'ar',
    );
    expect(html).not.toContain('NOL-INV');
    expect(html).not.toContain('250.5');
    expect(html).not.toContain('<h2>الفواتير</h2>');
    expect(html).not.toContain('<h2>الإجماليات</h2>');
  });
});
