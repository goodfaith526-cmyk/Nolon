'use client';

import { MIN_PASSWORD_LENGTH } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { field } from '@/lib/form';

export function ChangePasswordForm() {
  const t = useTranslations('Account');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const newPassword = field(form, 'newPassword');
    if (newPassword !== field(form, 'confirmPassword')) {
      setMessage({ ok: false, text: t('mismatch') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api('/auth/password', {
        method: 'POST',
        body: { currentPassword: field(form, 'currentPassword'), newPassword },
      });
      formElement.reset();
      setMessage({ ok: true, text: t('changed') });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setMessage({ ok: false, text: status === 400 ? t('rejected') : t('failed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack narrow" onSubmit={(e) => void onSubmit(e)}>
      <h1>{t('title')}</h1>
      <label className="field">
        <span>{t('currentPassword')}</span>
        <input name="currentPassword" type="password" autoComplete="current-password" required />
      </label>
      <label className="field">
        <span>{t('newPassword', { min: MIN_PASSWORD_LENGTH })}</span>
        <input
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </label>
      <label className="field">
        <span>{t('confirmPassword')}</span>
        <input name="confirmPassword" type="password" autoComplete="new-password" required />
      </label>
      {message && (
        <p className={message.ok ? 'success' : 'error'} role="status">
          {message.text}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy}>
        {t('submit')}
      </button>
    </form>
  );
}
