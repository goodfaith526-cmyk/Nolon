import { BadRequestException, ConflictException } from '@nestjs/common';
import type { CustomerDraftRequest, QuotationInput } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { fieldRefusal } from '../common/validation.js';
import { draftEvidencePaths } from '../drafts/draft-evidence.js';
import { decimalKey, requestHash } from '../drafts/draft-rules.js';
import { withReplaced } from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { evidenceLine } from './new-customer-quotation-drafts.controller.js';
import {
  customerOf,
  newCustomerQuotationHash,
  splitEvidence,
  storedCustomer,
  underQuotation,
} from './new-customer-quotation-drafts.service.js';
import { quotationRequestHash, storedLines } from './quotation-drafts.service.js';

const BRANCH = '0b6f6c1e-5f0e-4a43-9a51-6c3c6b0f0a01';
const customer: CustomerDraftRequest = { kind: 'INDIVIDUAL', name: 'Amna', phone: '+249912345678' };
const quotation: QuotationInput = {
  originLocationId: 'A5D3F1C2-1111-4222-8333-944455556666',
  destinationLocationId: 'b5d3f1c2-1111-4222-8333-944455556667',
  mode: 'ROAD',
  cargoType: 'GENERAL',
  currency: 'USD',
  validUntil: '2026-11-01',
  lines: [
    { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', quantity: '1.50' },
    { chargeTypeCode: 'THC', unit: 'PER_KG', quantity: '10', unitPrice: '2.500' },
  ],
};

describe('quotations for a new customer: the words', () => {
  it("tells the customer's words from the quotation's", () => {
    const words = splitEvidence([
      { field: 'name', quote: 'اسمها آمنة' },
      { field: 'lines[0].quantity', quote: 'شحنة ونص' },
      { field: 'branchId', quote: 'from Dubai' },
      { field: 'destinationLocationId', quote: 'to Port Sudan' },
    ]);
    expect(words.customer.map((e) => e.field)).toEqual(['name', 'branchId']);
    expect(words.quotation.map((e) => e.field)).toEqual([
      'lines[0].quantity',
      'destinationLocationId',
    ]);
  });

  it('accepts a line path only for the values a line has words for', () => {
    const schema = draftEvidencePaths((f) => f === 'name' || evidenceLine(f) !== null, 10);
    expect(schema.safeParse([{ field: 'lines[3].unitPrice', quote: '250' }]).success).toBe(true);
    expect(schema.safeParse([{ field: 'lines[3].discount', quote: '5' }]).success).toBe(true);
    expect(schema.safeParse([{ field: 'lines[0].rateCardId', quote: 'x' }]).success).toBe(false);
    expect(schema.safeParse([{ field: 'items[0].quantity', quote: 'x' }]).success).toBe(false);
    expect(evidenceLine('lines[12].quantity')).toBe(12);
    expect(evidenceLine('originLocationId')).toBeNull();
  });
});

describe('quotations for a new customer: the stored customer and the hash', () => {
  it('stores the customer with absent fields null, and reads it back', () => {
    const stored = storedCustomer(customer);
    expect(stored).toMatchObject({ name: 'Amna', email: null, companyName: null });
    const json = JSON.parse(JSON.stringify(stored)) as Prisma.JsonValue;
    expect(customerOf({ id: 'x', customer: json })).toEqual(stored);
    expect(() => customerOf({ id: 'x', customer: { name: 3 } })).toThrow();
  });

  it('hashes equal requests equally and any change otherwise', () => {
    const hash = newCustomerQuotationHash(BRANCH, customer, quotation);
    const sameValue: QuotationInput = {
      ...quotation,
      originLocationId: quotation.originLocationId.toLowerCase(),
      loadType: null,
      lines: [{ ...quotation.lines[0]!, quantity: '1.5' }, quotation.lines[1]!],
    };
    expect(newCustomerQuotationHash(BRANCH.toUpperCase(), customer, sameValue)).toBe(hash);
    const changed: QuotationInput = {
      ...quotation,
      lines: [quotation.lines[0]!, { ...quotation.lines[1]!, unitPrice: '2.51' }],
    };
    expect(newCustomerQuotationHash(BRANCH, customer, changed)).not.toBe(hash);
    expect(
      newCustomerQuotationHash(BRANCH, { ...customer, phone: '+249912345679' }, quotation),
    ).not.toBe(hash);
    expect(
      newCustomerQuotationHash(BRANCH, customer, quotation, [{ field: 'name', quote: 'Amna' }]),
    ).not.toBe(hash);
    expect(
      newCustomerQuotationHash(BRANCH, customer, quotation, [
        { field: 'lines[0].quantity', quote: '1.5' },
      ]),
    ).not.toBe(hash);
    const a = withReplaced(hash, 'A5D3F1C2-1111-4222-8333-944455550001');
    expect(a).not.toBe(hash);
    expect(withReplaced(hash, 'a5d3f1c2-1111-4222-8333-944455550001')).toBe(a);
  });

  it("leaves a quotation draft's hash as it was", () => {
    // Stored quotation drafts keep their key: the hash, as it was computed before it was shared.
    const request = { ...quotation, customerId: BRANCH.toUpperCase() };
    const before = requestHash({
      ...request,
      customerId: request.customerId.toLowerCase(),
      originLocationId: request.originLocationId.toLowerCase(),
      destinationLocationId: request.destinationLocationId.toLowerCase(),
      loadType: null,
      cargoDescription: null,
      terms: null,
      lines: storedLines(request).map((l) => ({
        ...l,
        rateCardId: l.rateCardId?.toLowerCase() ?? null,
        quantity: decimalKey(l.quantity),
        unitPrice: decimalKey(l.unitPrice),
        discount: decimalKey(l.discount),
      })),
    });
    expect(quotationRequestHash(request)).toBe(before);
  });
});

describe("quotations for a new customer: a refusal names the quotation's fields", () => {
  it('puts the fields of a refusal under quotation', async () => {
    const refused = await underQuotation(() =>
      Promise.reject(fieldRefusal('RATE_NO_MATCH', 'No rate', ['lines.0.unitPrice'])),
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BadRequestException);
    expect((refused as BadRequestException).getResponse()).toMatchObject({
      code: 'RATE_NO_MATCH',
      message: 'No rate',
      fields: ['quotation.lines.0.unitPrice'],
    });
  });

  it('passes any other error and any result unchanged', async () => {
    const conflict = new ConflictException('taken');
    await expect(underQuotation(() => Promise.reject(conflict))).rejects.toBe(conflict);
    const plain = new BadRequestException('Amounts are too large');
    await expect(underQuotation(() => Promise.reject(plain))).rejects.toBe(plain);
    await expect(underQuotation(() => Promise.resolve(3))).resolves.toBe(3);
  });
});
