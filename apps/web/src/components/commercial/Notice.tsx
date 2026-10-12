'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { ApiError } from '@/lib/api';
import { failureStatus } from '@/lib/master-data';

export interface NoticeState {
  ok: boolean;
  text: string;
}

/** The invalid fields a failed call names (request paths such as `items.0.weightKg`). */
export function invalidFields(e: unknown): ReadonlySet<string> {
  return new Set(e instanceof ApiError && e.status === 400 ? e.fields : []);
}

/**
 * Props that mark a form control as invalid when the last failed save named its path, so the
 * person sees which field to fix (and the first one gets the focus, see `focusFirstInvalid`).
 */
export function invalidProps(
  invalid: ReadonlySet<string>,
  path: string,
): { 'aria-invalid'?: true } {
  return invalid.has(path) ? { 'aria-invalid': true } : {};
}

/** As `invalidProps`, for a group of controls (a list of checkboxes, the cargo lines). */
export function invalidGroupProps(
  invalid: ReadonlySet<string>,
  path: string,
): { 'data-invalid'?: true } {
  return invalid.has(path) ? { 'data-invalid': true } : {};
}

/**
 * After a failed save, brings into view the first marked field or group, else the message (the
 * save button is at the foot of a long form, far from both), and focuses the first marked control.
 */
export function revealFailure(form: HTMLFormElement | null): void {
  const marked = form?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]');
  const control = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
  const target = marked ?? form?.querySelector<HTMLElement>('p.error[role="status"]');
  target?.scrollIntoView?.({ block: 'center' });
  control?.focus({ preventScroll: true });
}

/** Turns a failed API call into a message in the page language. */
export function useFailureText(): (e: unknown) => string {
  const t = useTranslations('Common');
  const tf = useTranslations('Fields');
  const reason = useRefusalReason();
  const locale = useLocale();
  return useCallback(
    (e: unknown) => {
      switch (failureStatus(e)) {
        case 400:
          return invalidInputText(e, {
            field: (key) => (tf.has(key) ? tf(key) : key),
            line: (n) => t('lineNo', { n }),
            list: (parts) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(parts),
            fields: (fields) => t('invalidFields', { fields }),
            because: (why, fields) => t('invalidBecause', { reason: why, fields }),
            reason,
            detail: (detail) => t('invalidDetail', { detail }),
            generic: () => t('invalidInput'),
          });
        case 403:
          return t('noAccess');
        case 404:
          return t('notFound');
        case 409:
          return t('conflict');
        default:
          return t('failed');
      }
    },
    [t, tf, reason, locale],
  );
}

/**
 * Why the API refused a save on named fields, in the page language when it sent a known code
 * (`Refusals`), else in its own words; null when it named no rule.
 */
export function useRefusalReason(): (e: unknown) => string | null {
  const tr = useTranslations('Refusals');
  return useCallback(
    (e: unknown) => {
      if (!(e instanceof ApiError) || e.fields.length === 0) return null;
      if (e.code && tr.has(e.code)) return tr(e.code);
      return e.reason;
    },
    [tr],
  );
}

/** Where to say why a save was refused: under the first field the API named. */
export interface FieldNoteState {
  path: string;
  text: string;
}

export function fieldNote(e: unknown, reason: string | null): FieldNoteState | null {
  const first = e instanceof ApiError ? e.fields[0] : undefined;
  return first !== undefined && reason ? { path: first, text: reason } : null;
}

/** The reason under a field, when the last refused save named it first. */
export function FieldNote({ note, path }: { note: FieldNoteState | null; path: string }) {
  if (note?.path !== path) return null;
  return <small className="field-error">{note.text}</small>;
}

export interface InvalidInputWords {
  field: (key: string) => string;
  line: (n: number) => string;
  list: (parts: string[]) => string;
  fields: (fields: string) => string;
  because: (reason: string, fields: string) => string;
  reason: (e: unknown) => string | null;
  detail: (detail: string) => string;
  generic: () => string;
}

/**
 * A refused save (400) in words: the fields the API named ("Weight (kg) (line 1)") with the rule's
 * reason when there is one, else the API's own reason, else the generic "check the fields".
 */
export function invalidInputText(e: unknown, words: InvalidInputWords): string {
  if (!(e instanceof ApiError)) return words.generic();
  if (e.fields.length > 0) {
    const names = words.list([...new Set(e.fields.map((path) => fieldName(path, words)))]);
    const reason = words.reason(e);
    return reason ? words.because(reason, names) : words.fields(names);
  }
  const reason = e.message.trim();
  return reason && reason !== 'Bad Request' ? words.detail(reason) : words.generic();
}

/** `items.0.weightKg` → "Weight (kg) (line 1)"; a path-less issue keeps the API's text. */
function fieldName(path: string, words: InvalidInputWords): string {
  if (!/^[A-Za-z0-9_.]+$/.test(path)) return path;
  const parts = path.split('.');
  const line = parts.find((p) => /^\d+$/.test(p));
  const named = parts.filter((p) => !/^\d+$/.test(p));
  const last = named[named.length - 1] ?? path;
  const label = words.field(last);
  return line === undefined ? label : `${label} (${words.line(Number(line) + 1)})`;
}

export function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  return (
    <p className={notice.ok ? 'success' : 'error'} role="status">
      {notice.text}
    </p>
  );
}
