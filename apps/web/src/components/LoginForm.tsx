'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { ApiError, api } from '@/lib/api';
import { field } from '@/lib/form';

export function LoginForm() {
  const t = useTranslations('Login');
  const router = useRouter();
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

  return (
    <main className="auth-page">
      <form className="card stack" onSubmit={(e) => void onSubmit(e)}>
        <h1>{t('title')}</h1>
        <label className="field">
          <span>{t('email')}</span>
          <input name="email" type="email" autoComplete="username" required dir="ltr" />
        </label>
        <label className="field">
          <span>{t('password')}</span>
          <input name="password" type="password" autoComplete="current-password" required />
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
    </main>
  );
}
