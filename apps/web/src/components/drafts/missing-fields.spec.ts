import { describe, expect, it } from 'vitest';
import { parsePath, patchBody } from './missing-fields';

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
