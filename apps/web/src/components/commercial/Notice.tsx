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
    [t, tf, locale],
  );
}

export interface InvalidInputWords {
  field: (key: string) => string;
  line: (n: number) => string;
  list: (parts: string[]) => string;
  fields: (fields: string) => string;
  detail: (detail: string) => string;
  generic: () => string;
}

/**
 * A refused save (400) in words: the fields the API named ("Weight (kg) (line 1)"), else the
 * API's own reason when it gave one, else the generic "check the fields".
 */
export function invalidInputText(e: unknown, words: InvalidInputWords): string {
  if (!(e instanceof ApiError)) return words.generic();
  if (e.fields.length > 0) {
    const names = [...new Set(e.fields.map((path) => fieldName(path, words)))];
    return words.fields(words.list(names));
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
