'use client';

import type { AuthMeResponse } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { ApiError, api } from '@/lib/api';
import { MeContext } from '../StaffShell';

/**
 * Session for the printouts: like StaffShell (sign-in required, the user for permission checks)
 * without the menu, so the page is only the document. The API checks every permission and branch.
 */
export function PrintShell({ children }: { children: ReactNode }) {
  const t = useTranslations('Shell');
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<AuthMeResponse>('/auth/me')
      .then((data) => {
        if (!cancelled) setMe(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
        else setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  if (failed) return <p className="page error">{t('loadFailed')}</p>;
  if (!me) return <p className="page muted loading">{t('loading')}</p>;
  return (
    <MeContext value={me}>
      <div className="print-root">{children}</div>
    </MeContext>
  );
}
