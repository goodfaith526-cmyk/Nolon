'use client';

import { useLocale, useTranslations } from 'next-intl';
import Image from 'next/image';
import { type FormEvent, useState } from 'react';
import logoAr from '@/assets/brand/logo-ar.webp';
import logoEn from '@/assets/brand/logo-en.webp';
import { useRouter } from '@/i18n/navigation';
import { ApiError, api } from '@/lib/api';
import { field } from '@/lib/form';

export function LoginForm() {
  const t = useTranslations('Login');
  const router = useRouter();
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', {
        method: 'POST',
        body: { email: field(form, 'email'), password: field(form, 'password') },
      });
      router.replace('/dashboard');
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setError(status === 401 ? t('invalid') : status === 429 ? t('tooManyAttempts') : t('failed'));
      setBusy(false);
    }
  }

  const logo = locale === 'ar' ? logoAr : logoEn;
  return (
    <main className="auth-page">
      <aside className="auth-brand">
        <span className="auth-brand-logo">
          <Image src={logo} alt="NOLON" width={150} priority unoptimized />
        </span>
        <div>
          <h2>{t('brandTitle')}</h2>
          <p>{t('brandLead')}</p>
        </div>
        <ul className="auth-branches">
          <li>{t('pointShipments')}</li>
          <li>{t('pointBilling')}</li>
          <li>{t('pointAccounting')}</li>
        </ul>
      </aside>
      <div className="auth-main">
        <form className="card stack" onSubmit={(e) => void onSubmit(e)}>
          <Image src={logo} alt="NOLON" className="auth-logo" width={176} unoptimized />
          <div>
            <h1>{t('title')}</h1>
            <p className="muted auth-subtitle">{t('subtitle')}</p>
          </div>
          <label className="field">
            <span>{t('email')}</span>
            <input name="email" type="email" autoComplete="username" required dir="ltr" />
          </label>
          <label className="field">
            <span>{t('password')}</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              dir="ltr"
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t('signingIn') : t('submit')}
          </button>
        </form>
      </div>
    </main>
  );
}
