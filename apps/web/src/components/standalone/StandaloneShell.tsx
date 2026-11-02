'use client';

import type { AuthMeResponse } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type ReactNode, createContext, use, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { MeContext } from '../StaffShell';
import { guardStandaloneLinks } from './standalone-links';

/** True inside a standalone window (one record, no way into the rest of the system). */
export const StandaloneContext = createContext(false);

export function useStandalone(): boolean {
  return use(StandaloneContext);
}

/**
 * A shipment in a window of its own: the same sign-in, permissions and branch checks as the staff
 * screens (the API enforces them), without the menu, header or assistant, and with every link to
 * another page disabled. A lost session is reported here instead of sending the window to sign-in
 * (which would lead on into the system); the person signs in again in the main window.
 */
export function StandaloneShell({
  shipmentId,
  children,
}: {
  shipmentId: string;
  children: ReactNode;
}) {
  const t = useTranslations('Shell');
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [failure, setFailure] = useState<'signedOut' | 'failed' | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api<AuthMeResponse>('/auth/me')
      .then((data) => {
        if (!cancelled) setMe(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFailure(e instanceof ApiError && e.status === 401 ? 'signedOut' : 'failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!me || !root.current) return;
    return guardStandaloneLinks(root.current, shipmentId);
  }, [me, shipmentId]);

  if (failure === 'signedOut') return <p className="page error">{t('standaloneSignedOut')}</p>;
  if (failure === 'failed') return <p className="page error">{t('loadFailed')}</p>;
  if (!me) return <p className="page muted loading">{t('loading')}</p>;
  return (
    <MeContext value={me}>
      <StandaloneContext value>
        <main className="page standalone-root" ref={root}>
          {children}
        </main>
      </StandaloneContext>
    </MeContext>
  );
}
