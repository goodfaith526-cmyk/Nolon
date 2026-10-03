'use client';

import type { AuthMeResponse, Permission } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type ReactNode, createContext, use, useEffect, useState } from 'react';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { ApiError, api } from '@/lib/api';

const MeContext = createContext<AuthMeResponse | null>(null);

/** The signed-in user, as /auth/me returned it. Only inside StaffShell. */
export function useMe(): AuthMeResponse {
  const me = use(MeContext);
  if (!me) throw new Error('useMe outside StaffShell');
  return me;
}

/** Shows UI only; the API enforces every permission on its own. */
export function can(me: AuthMeResponse, permission: Permission): boolean {
  return me.permissions.includes(permission);
}

/** Loads the session for every staff page; sends the visitor to sign-in when there is none. */
export function StaffShell({ children }: { children: ReactNode }) {
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

  async function signOut() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
    }
  }

  if (failed) return <p className="page error">{t('loadFailed')}</p>;
  if (!me) return <p className="page muted">{t('loading')}</p>;

  return (
    <MeContext value={me}>
      <header className="topbar">
        <nav className="nav">
          <Link href="/dashboard" className={pathname === '/dashboard' ? 'active' : ''}>
            {t('home')}
          </Link>
          {can(me, 'users:view') && (
            <Link href="/users" className={pathname === '/users' ? 'active' : ''}>
              {t('users')}
            </Link>
          )}
          <Link href="/account" className={pathname === '/account' ? 'active' : ''}>
            {t('account')}
          </Link>
        </nav>
        <div className="nav">
          <span className="muted">{me.fullName}</span>
          <button type="button" onClick={() => void signOut()}>
            {t('signOut')}
          </button>
        </div>
      </header>
      <main className="page">{children}</main>
    </MeContext>
  );
}
