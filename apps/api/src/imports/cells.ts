import type { ImportRowError } from '@nolon/shared';
import type ExcelJS from 'exceljs';
import { isDateString } from '../common/dates.js';
import { dec } from '../common/money.js';

/**
 * Reading one spreadsheet cell as a value, never as a calculation. Formulas are refused (their
 * cached results are not trusted, and nothing is ever evaluated); amounts come from the cell's
 * text as a decimal string, so no binary floating point decides an amount's digits.
 */

export type RawCell =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: Date }
  | { kind: 'formula' }
  | { kind: 'error' };

export type CellResult<T> =
  { ok: true; value: T } | { ok: false; code: ImportRowError; message: string };

const EMPTY: RawCell = { kind: 'empty' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Classifies an exceljs cell value. Rich text and hyperlinks become their plain text. */
export function rawCell(value: ExcelJS.CellValue | undefined): RawCell {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === 'string') return { kind: 'text', text: value };
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (value instanceof Date) return { kind: 'date', value };
  if (!isObject(value)) return { kind: 'error' };
  if ('formula' in value || 'sharedFormula' in value) return { kind: 'formula' };
  if ('error' in value) return { kind: 'error' };
  if ('richText' in value && Array.isArray(value.richText)) {
    const text = value.richText
      .map((part: unknown) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
    return { kind: 'text', text };
  }
  if ('text' in value && typeof value.text === 'string') return { kind: 'text', text: value.text };
  return { kind: 'error' };
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** Arabic-Indic and Persian digits to ASCII, the Arabic decimal separator to a dot. */
export function normalizeDigits(text: string): string {
  return text
    .replace(ARABIC_DIGITS, (d) => {
      const code = d.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .replace(/٫/g, '.');
}

const fail = (code: ImportRowError, message: string): CellResult<never> => ({
  ok: false,
  code,
  message,
});

function formulaOrError<T>(raw: RawCell): CellResult<T> | null {
  if (raw.kind === 'formula') {
    return fail('FORMULA_NOT_ALLOWED', 'Formulas are not accepted; paste the values only');
  }
  if (raw.kind === 'error') return fail('INVALID_FORMAT', 'The cell holds an error or an object');
  return null;
}

/** Significant digits a double reproduces exactly when written back as decimal text. */
const DOUBLE_SAFE_DIGITS = 15;

/** The shortest decimal text of a double (what Excel shows for up to 15 digits). */
function numberText(value: number): string {
  return dec(String(value)).toFixed();
}

/**
 * Text: trimmed; blank is null. Numbers become their plain decimal text, dates YYYY-MM-DD. A
 * number with more than 15 significant digits (a long tax or phone number typed as a number) has
 * already lost digits in Excel, so it is refused rather than stored rounded.
 */
export function cellText(raw: RawCell): CellResult<string | null> {
  const refused = formulaOrError<string | null>(raw);
  if (refused) return refused;
  switch (raw.kind) {
    case 'text': {
      const text = raw.text.trim();
      return { ok: true, value: text === '' ? null : text };
    }
    case 'number':
      if (!Number.isFinite(raw.value)) return fail('INVALID_FORMAT', 'Not a finite number');
      if (dec(String(raw.value)).sd(true) > DOUBLE_SAFE_DIGITS) {
        return fail(
          'INVALID_FORMAT',
          'The number has too many digits to be read exactly; enter it as text',
        );
      }
      return { ok: true, value: numberText(raw.value) };
    case 'boolean':
      return { ok: true, value: raw.value ? 'TRUE' : 'FALSE' };
    case 'date':
      return { ok: true, value: raw.value.toISOString().slice(0, 10) };
    default:
      return { ok: true, value: null };
  }
}

/** A code from a list (branch, currency, enum): trimmed and upper-cased. */
export function cellCode(raw: RawCell): CellResult<string | null> {
  const text = cellText(raw);
  if (!text.ok || text.value === null) return text;
  return { ok: true, value: normalizeDigits(text.value).toUpperCase() };
}

/**
 * A non-negative amount as a decimal string with at most `scale` decimal places and
 * `integerDigits` digits before the point. A text cell is read digit by digit; a numeric cell is
 * accepted only when its shortest decimal text has at most 15 significant digits and fits the
 * scale, so the stored amount is exactly what was typed. Nothing is rounded.
 */
export function cellAmount(raw: RawCell, scale = 4, integerDigits = 14): CellResult<string | null> {
  const refused = formulaOrError<string | null>(raw);
  if (refused) return refused;
  let text: string;
  if (raw.kind === 'empty') return { ok: true, value: null };
  if (raw.kind === 'text') {
    text = normalizeDigits(raw.text).trim();
    if (text === '') return { ok: true, value: null };
    if (!/^\d+(\.\d+)?$/.test(text)) {
      return fail('INVALID_AMOUNT', 'Write the amount as digits with an optional decimal point');
    }
  } else if (raw.kind === 'number') {
    if (!Number.isFinite(raw.value) || raw.value < 0) {
      return fail('INVALID_AMOUNT', 'The amount must be zero or positive');
    }
    text = String(raw.value);
    if (dec(text).sd(true) > DOUBLE_SAFE_DIGITS) {
      return fail(
        'AMOUNT_NOT_EXACT',
        'The number has too many digits to be read exactly; enter it as text',
      );
    }
  } else {
    return fail('INVALID_AMOUNT', 'Not an amount');
  }
  const value = dec(text);
  if (value.decimalPlaces() > scale) {
    return fail('AMOUNT_NOT_EXACT', `At most ${scale} decimal places; nothing is rounded`);
  }
  if (value.truncated().toFixed().length > integerDigits) {
    return fail('INVALID_AMOUNT', `At most ${integerDigits} digits before the decimal point`);
  }
  return { ok: true, value: value.toFixed() };
}

/** A calendar date: a date cell, or text as YYYY-MM-DD. */
export function cellDate(raw: RawCell): CellResult<string | null> {
  const refused = formulaOrError<string | null>(raw);
  if (refused) return refused;
  if (raw.kind === 'empty') return { ok: true, value: null };
  if (raw.kind === 'date') {
    if (Number.isNaN(raw.value.getTime())) return fail('INVALID_DATE', 'Not a valid date');
    return { ok: true, value: raw.value.toISOString().slice(0, 10) };
  }
  if (raw.kind === 'text') {
    const text = normalizeDigits(raw.text).trim();
    if (text === '') return { ok: true, value: null };
    if (isDateString(text)) return { ok: true, value: text };
  }
  return fail('INVALID_DATE', 'Write the date as YYYY-MM-DD');
}

/** A whole count (days), not money. */
export function cellInteger(raw: RawCell): CellResult<number | null> {
  const refused = formulaOrError<number | null>(raw);
  if (refused) return refused;
  if (raw.kind === 'empty') return { ok: true, value: null };
  if (raw.kind === 'number' && Number.isSafeInteger(raw.value) && raw.value >= 0) {
    return { ok: true, value: raw.value };
  }
  if (raw.kind === 'text') {
    const text = normalizeDigits(raw.text).trim();
    if (text === '') return { ok: true, value: null };
    if (/^\d{1,6}$/.test(text)) return { ok: true, value: Number.parseInt(text, 10) };
  }
  return fail('INVALID_INTEGER', 'Write a whole number');
}

/** A phone number: text with spaces, dashes and brackets removed. */
export function cellPhone(raw: RawCell): CellResult<string | null> {
  const text = cellText(raw);
  if (!text.ok || text.value === null) return text;
  return { ok: true, value: normalizeDigits(text.value).replace(/[\s\-()]/g, '') };
}
