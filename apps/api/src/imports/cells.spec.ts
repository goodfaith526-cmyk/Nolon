import type ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  type RawCell,
  cellAmount,
  cellCode,
  cellDate,
  cellInteger,
  cellPhone,
  cellText,
  normalizeDigits,
  rawCell,
} from './cells.js';

const text = (t: string): RawCell => ({ kind: 'text', text: t });
const num = (value: number): RawCell => ({ kind: 'number', value });

describe('rawCell', () => {
  it('classifies exceljs values', () => {
    expect(rawCell(null)).toEqual({ kind: 'empty' });
    expect(rawCell(undefined)).toEqual({ kind: 'empty' });
    expect(rawCell('a')).toEqual({ kind: 'text', text: 'a' });
    expect(rawCell(3)).toEqual({ kind: 'number', value: 3 });
    expect(rawCell(true)).toEqual({ kind: 'boolean', value: true });
    expect(rawCell({ formula: 'A1*2', result: 4 })).toEqual({ kind: 'formula' });
    expect(rawCell({ sharedFormula: 'A1', result: 4 })).toEqual({ kind: 'formula' });
    expect(rawCell({ error: '#N/A' } as unknown as ExcelJS.CellValue)).toEqual({ kind: 'error' });
  });

  it('reads rich text and hyperlinks as their plain text', () => {
    expect(rawCell({ richText: [{ text: 'Al ' }, { text: 'Noor' }] })).toEqual({
      kind: 'text',
      text: 'Al Noor',
    });
    expect(rawCell({ text: 'a@b.co', hyperlink: 'mailto:a@b.co' })).toEqual({
      kind: 'text',
      text: 'a@b.co',
    });
  });
});

describe('cellAmount', () => {
  it('reads text digit by digit, without rounding', () => {
    expect(cellAmount(text('1250.50'))).toEqual({ ok: true, value: '1250.5' });
    expect(cellAmount(text(' 0 '))).toEqual({ ok: true, value: '0' });
    expect(cellAmount(text('99999999999999.9999'))).toEqual({
      ok: true,
      value: '99999999999999.9999',
    });
    expect(cellAmount(text('١٢٣٫٤٥'))).toEqual({ ok: true, value: '123.45' });
  });

  it('accepts a numeric cell only when its decimal text is exact and fits the scale', () => {
    expect(cellAmount(num(1250.5))).toEqual({ ok: true, value: '1250.5' });
    expect(cellAmount(num(0.1))).toEqual({ ok: true, value: '0.1' });
    expect(cellAmount(num(100))).toEqual({ ok: true, value: '100' });
    expect(cellAmount(num(1.23456))).toMatchObject({ ok: false, code: 'AMOUNT_NOT_EXACT' });
    expect(cellAmount(num(1e-7))).toMatchObject({ ok: false, code: 'AMOUNT_NOT_EXACT' });
    // A third, as Excel stores it: 16 significant digits, more than a double can be trusted for.
    expect(cellAmount(num(1 / 3))).toMatchObject({
      ok: false,
      code: 'AMOUNT_NOT_EXACT',
    });
  });

  it('refuses what is not a plain non-negative amount', () => {
    for (const bad of ['1,234.5', '-5', '12a', '1.2.3', '$10', '1e3']) {
      expect(cellAmount(text(bad))).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
    }
    expect(cellAmount(num(-1))).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
    expect(cellAmount(num(Number.NaN))).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
    expect(cellAmount(text('1.00001'))).toMatchObject({ ok: false, code: 'AMOUNT_NOT_EXACT' });
    expect(cellAmount(text('123456789012345'))).toMatchObject({
      ok: false,
      code: 'INVALID_AMOUNT',
    });
    expect(cellAmount({ kind: 'boolean', value: true })).toMatchObject({ ok: false });
    expect(cellAmount({ kind: 'date', value: new Date() })).toMatchObject({ ok: false });
  });

  it('refuses formulas and treats blanks as empty', () => {
    expect(cellAmount({ kind: 'formula' })).toMatchObject({
      ok: false,
      code: 'FORMULA_NOT_ALLOWED',
    });
    expect(cellAmount({ kind: 'empty' })).toEqual({ ok: true, value: null });
    expect(cellAmount(text('  '))).toEqual({ ok: true, value: null });
  });
});

describe('cellDate', () => {
  it('reads date cells and YYYY-MM-DD text', () => {
    expect(cellDate({ kind: 'date', value: new Date('2026-03-01T00:00:00Z') })).toEqual({
      ok: true,
      value: '2026-03-01',
    });
    expect(cellDate(text('2026-12-31'))).toEqual({ ok: true, value: '2026-12-31' });
    expect(cellDate({ kind: 'empty' })).toEqual({ ok: true, value: null });
  });

  it('refuses other forms', () => {
    for (const bad of [text('31/12/2026'), text('2026-02-30'), num(46000)]) {
      expect(cellDate(bad)).toMatchObject({ ok: false, code: 'INVALID_DATE' });
    }
    expect(cellDate({ kind: 'formula' })).toMatchObject({ code: 'FORMULA_NOT_ALLOWED' });
  });
});

describe('cellInteger, cellText, cellCode, cellPhone', () => {
  it('reads whole counts', () => {
    expect(cellInteger(num(30))).toEqual({ ok: true, value: 30 });
    expect(cellInteger(text('٤٥'))).toEqual({ ok: true, value: 45 });
    expect(cellInteger(num(1.5))).toMatchObject({ ok: false, code: 'INVALID_INTEGER' });
    expect(cellInteger(text('ten'))).toMatchObject({ ok: false, code: 'INVALID_INTEGER' });
  });

  it('trims text and writes numbers as plain decimals', () => {
    expect(cellText(text('  Al Noor  '))).toEqual({ ok: true, value: 'Al Noor' });
    expect(cellText(text('   '))).toEqual({ ok: true, value: null });
    expect(cellText(num(12345))).toEqual({ ok: true, value: '12345' });
    expect(cellText({ kind: 'error' })).toMatchObject({ ok: false, code: 'INVALID_FORMAT' });
  });

  it('upper-cases codes and compacts phones', () => {
    expect(cellCode(text(' dxb '))).toEqual({ ok: true, value: 'DXB' });
    expect(cellPhone(text('+249 91-234 5678'))).toEqual({ ok: true, value: '+249912345678' });
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩ ۴')).toBe('0123456789 4');
  });
});
