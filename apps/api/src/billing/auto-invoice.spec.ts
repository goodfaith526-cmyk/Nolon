import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { autoApprovalRule } from './auto-invoice.service.js';
import type { DerivedInvoiceLine } from './invoices.service.js';

const filled = (priceSource: DerivedInvoiceLine['priceSource']): DerivedInvoiceLine => ({
  chargeTypeCode: 'FREIGHT',
  description: null,
  unit: 'PER_PIECE',
  quantity: dec('1'),
  unitPrice: dec('100'),
  priceSource,
  rateCardId: priceSource === 'RATE_CARD' ? 'r' : null,
  service: 'MAIN_FREIGHT',
  use: 'FILL',
  fillPrice: false,
});

const quoted = { lines: [filled('QUOTATION')], unresolved: [] };
const carded = { lines: [filled('RATE_CARD')], unresolved: [] };
const matching = { approved: true, matches: true, reconciled: true };

describe('autoApprovalRule (plan 12 section 2.1)', () => {
  it('approves an agreed price whose terms still match, with or without the right', () => {
    for (const mayApprove of [true, false]) {
      expect(
        autoApprovalRule({
          enabled: true,
          derivation: quoted,
          agreed: matching,
          services: [],
          mayApprove,
        }),
      ).toEqual({ rule: 'AGREED_PRICE' });
    }
  });

  it('keeps a draft when the agreed terms changed, or the quotation is no longer approved', () => {
    for (const agreed of [
      { approved: true, matches: false, reconciled: true },
      { approved: false, matches: true, reconciled: true },
    ]) {
      expect(
        autoApprovalRule({
          enabled: true,
          derivation: quoted,
          agreed,
          services: [],
          mayApprove: true,
        }),
      ).toEqual({ note: 'AGREED_TERMS_CHANGED' });
    }
  });

  it('approves rate card prices only for a confirmer who may approve invoices', () => {
    expect(
      autoApprovalRule({
        enabled: true,
        derivation: carded,
        agreed: null,
        services: [],
        mayApprove: true,
      }),
    ).toEqual({ rule: 'RATE_CARD_WITH_RIGHT' });
    expect(
      autoApprovalRule({
        enabled: true,
        derivation: carded,
        agreed: null,
        services: [],
        mayApprove: false,
      }),
    ).toEqual({ note: 'NO_APPROVE_RIGHT' });
  });

  it('keeps a draft when a line is offered, unpriced or unresolved', () => {
    const offered = { ...filled('RATE_CARD'), use: 'OFFER' as const };
    const unpriced = { ...filled('RATE_CARD'), unitPrice: null };
    for (const derivation of [
      { lines: [filled('RATE_CARD'), offered], unresolved: [] },
      { lines: [unpriced], unresolved: [] },
      {
        lines: [filled('RATE_CARD')],
        unresolved: [{ path: 'lines', code: 'RATE_SEVERAL' as const, message: '' }],
      },
      { lines: [], unresolved: [] },
    ]) {
      expect(
        autoApprovalRule({
          enabled: true,
          derivation,
          agreed: null,
          services: [],
          mayApprove: true,
        }),
      ).toEqual({ note: 'PRICE_INCOMPLETE' });
    }
  });

  it('never approves a mix of agreed and rate card prices', () => {
    const mixed = { lines: [filled('QUOTATION'), filled('RATE_CARD')], unresolved: [] };
    expect(
      autoApprovalRule({
        enabled: true,
        derivation: mixed,
        agreed: matching,
        services: [],
        mayApprove: true,
      }),
    ).toEqual({ note: 'PRICE_INCOMPLETE' });
  });

  it('keeps a draft when the quotation does not price the booked cargo (F193-1)', () => {
    const agreed = { approved: true, matches: true, reconciled: false };
    expect(
      autoApprovalRule({
        enabled: true,
        derivation: quoted,
        agreed,
        services: [],
        mayApprove: true,
      }),
    ).toEqual({ note: 'AGREED_PRICE_MISMATCH' });
  });

  it('keeps a draft when a booked service has no priced line (F193-2)', () => {
    const customsOnly = {
      lines: [{ ...filled('RATE_CARD'), service: 'CUSTOMS' as const }],
      unresolved: [],
    };
    const decide = (services: string[]) =>
      autoApprovalRule({
        enabled: true,
        derivation: customsOnly,
        agreed: null,
        services,
        mayApprove: true,
      });
    expect(decide(['MAIN_FREIGHT', 'CUSTOMS'])).toEqual({ note: 'PRICE_INCOMPLETE' });
    expect(decide(['CUSTOMS'])).toEqual({ rule: 'RATE_CARD_WITH_RIGHT' });
  });

  it('keeps a draft with the switch off, whatever else holds', () => {
    expect(
      autoApprovalRule({
        enabled: false,
        derivation: quoted,
        agreed: matching,
        services: [],
        mayApprove: true,
      }),
    ).toEqual({ note: 'SWITCH_OFF' });
    expect(
      autoApprovalRule({
        enabled: false,
        derivation: carded,
        agreed: null,
        services: [],
        mayApprove: true,
      }),
    ).toEqual({ note: 'SWITCH_OFF' });
  });
});

/** Every .ts file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('automatic approval is server-only (plan 12 section 2.1, F190-1)', () => {
  const root = join(import.meta.dirname, '..');
  const files = sources(root).map((path) => ({
    // Forward slashes on every system (Codex ran it on Windows).
    path: path
      .slice(root.length + 1)
      .split(sep)
      .join('/'),
    text: readFileSync(path, 'utf8'),
  }));

  it('is set only by the service run as a booking confirmation’s last step', () => {
    const setting = files.filter((f) => /approvalSource:\s*'AUTO_ON_CONFIRM',/.test(f.text));
    expect(setting.map((f) => f.path)).toEqual(['billing/auto-invoice.service.ts']);
  });

  it('is reached by no controller', () => {
    const controllers = files.filter((f) => f.path.endsWith('.controller.ts'));
    for (const c of controllers) {
      expect(c.text, c.path).not.toMatch(/AutoInvoiceService|approveInTx|AUTO_ON_CONFIRM/);
    }
  });

  it('registers as the bookings’ final step, called by every caller of confirmInTx', () => {
    const auto = files.find((f) => f.path === 'billing/auto-invoice.service.ts')!;
    expect(auto.text).toMatch(/confirmChecks\.registerFinal\(/);
    const confirming = files.filter((f) => /\.confirmInTx\(|\.bookInTx\(/.test(f.text));
    for (const f of confirming) {
      expect(f.text, f.path).toMatch(/finalChecksInTx\(tx, user, /);
    }
  });
});
