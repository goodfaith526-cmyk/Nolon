import { describe, expect, it } from 'vitest';
import { NEW_INVOICE_LINE_FIELDS, parsePath, patchBody } from './missing-fields';

describe('MissingFields: the PATCH body', () => {
  it('reads a line path and a plain one', () => {
    expect(parsePath('lines[2].quantity')).toEqual({
      path: 'lines[2].quantity',
      list: 'lines',
      index: 2,
      field: 'quantity',
    });
    expect(parsePath('mode')).toEqual({ path: 'mode', field: 'mode' });
  });

  it("reads a part's path: the part, then the field or the line", () => {
    expect(parsePath('customer.name')).toEqual({
      path: 'customer.name',
      group: 'customer',
      field: 'name',
    });
    expect(parsePath('quotation.lines[1].quantity')).toEqual({
      path: 'quotation.lines[1].quantity',
      group: 'quotation',
      list: 'lines',
      index: 1,
      field: 'quantity',
    });
  });

  it("puts a part's values under the part, a line in a copy of that part's lines", () => {
    const request = {
      customer: { name: null },
      quotation: { lines: [{ chargeTypeCode: 'FREIGHT', quantity: null }] },
    };
    const paths = ['customer.name', 'customer.phone', 'quotation.lines[0].quantity'].map(parsePath);
    expect(
      patchBody(request, paths, {
        'customer.name': 'Amna',
        'quotation.lines[0].quantity': '2',
      }),
    ).toEqual({
      customer: { name: 'Amna' },
      quotation: { lines: [{ chargeTypeCode: 'FREIGHT', quantity: '2' }] },
    });
  });

  it("adds a new line under its part, and an invoice's without a unit", () => {
    const values = {
      'quotation.lines.new.chargeTypeCode': 'FREIGHT',
      'quotation.lines.new.quantity': '1',
    };
    expect(patchBody({ quotation: { lines: [] } }, [parsePath('quotation.lines')], values)).toEqual(
      { quotation: { lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1' }] } },
    );
    const invoice = { 'lines.new.unit': 'PER_KG', 'lines.new.quantity': '3' };
    expect(
      patchBody({ lines: [] }, [parsePath('lines')], invoice, NEW_INVOICE_LINE_FIELDS),
    ).toEqual({ lines: [{ quantity: '3' }] });
  });

  it("sends a release's packages as a whole number", () => {
    expect(patchBody({}, [parsePath('packages')], { packages: '12' })).toEqual({ packages: 12 });
  });

  it('sends each value typed at its place, leaves the empty ones missing', () => {
    const paths = ['mode', 'currency', 'shipmentIds'].map(parsePath);
    expect(patchBody({}, paths, { mode: 'SEA', currency: '', shipmentIds: ['s1'] })).toEqual({
      mode: 'SEA',
      shipmentIds: ['s1'],
    });
  });

  it("fills a line's value in a copy of the draft's lines, without their null values", () => {
    const request = {
      lines: [
        { rateCardId: 'r1', quantity: null, description: null },
        { chargeTypeCode: 'FREIGHT', quantity: '1' },
      ],
    };
    const body = patchBody(request, [parsePath('lines[0].quantity')], {
      'lines[0].quantity': '3.5',
    });
    expect(body).toEqual({
      lines: [
        { rateCardId: 'r1', quantity: '3.5' },
        { chargeTypeCode: 'FREIGHT', quantity: '1' },
      ],
    });
    expect(request.lines[0]?.quantity).toBeNull();
  });

  it("sends a booking line's pieces as a whole number", () => {
    const body = patchBody(
      { items: [{ cargoType: 'GENERAL', quantity: null }] },
      [parsePath('items[0].quantity')],
      { 'items[0].quantity': '4' },
    );
    expect(body).toEqual({ items: [{ cargoType: 'GENERAL', quantity: 4 }] });
  });

  it('adds the new line typed to a quotation saved without lines', () => {
    const values = { 'lines.new.chargeTypeCode': 'FREIGHT', 'lines.new.quantity': '1' };
    expect(patchBody({ lines: [] }, [parsePath('lines')], values)).toEqual({
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1' }],
    });
    expect(patchBody({ lines: [] }, [parsePath('lines')], {})).toEqual({});
  });
});
