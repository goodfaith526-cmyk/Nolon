'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { failureStatus } from '@/lib/master-data';

export interface NoticeState {
  ok: boolean;
  text: string;
}

/** Turns a failed API call into a message in the page language. */
export function useFailureText(): (e: unknown) => string {
  const t = useTranslations('Common');
  return useCallback(
    (e: unknown) => {
      switch (failureStatus(e)) {
        case 400:
          return t('invalidInput');
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
    [t],
  );
}

export function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  return (
    <p className={notice.ok ? 'success' : 'error'} role="status">
      {notice.text}
    </p>
  );
}
