'use client';

import {
  LOCALES,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  ROLES,
  type Locale,
  type Role,
  type UserSummary,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { field } from '@/lib/form';
import { can, useMe } from './StaffShell';

type Mode =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'edit'; user: UserSummary }
  | { kind: 'reset'; user: UserSummary };

export function UsersAdmin() {
  const t = useTranslations('Users');
  const tRoles = useTranslations('Roles');
  const locale = useLocale();
  const me = useMe();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const branchName = useCallback(
    (id: string) => {
      const branch = me.branches.find((b) => b.id === id);
      if (!branch) return id;
      return locale === 'ar' ? branch.nameAr : branch.nameEn;
    },
    [me.branches, locale],
  );
  const list = useCallback(
    (items: string[]) => new Intl.ListFormat(locale).format(items),
    [locale],
  );

  const load = useCallback(() => {
    api<UserSummary[]>('/users')
      .then(setUsers)
      .catch(() => setNotice({ ok: false, text: t('loadFailed') }));
  }, [t]);

  useEffect(load, [load]);

  if (!can(me, 'users:view')) return <p className="error">{t('noAccess')}</p>;

  function errorText(e: unknown): string {
    if (!(e instanceof ApiError)) return t('failed');
    if (e.status === 409 && /email/i.test(e.message)) return t('emailTaken');
    if (e.status === 409) return t('lastAdmin');
    if (e.status === 400 && /own account/i.test(e.message)) return t('cannotDeactivateSelf');
    if (e.status === 400 && /branch/i.test(e.message)) return t('branchRequired');
    if (e.status === 400) return t('invalidInput');
    if (e.status === 403) return t('noAccess');
    return t('failed');
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setNotice(null);
    try {
      await action();
      setNotice({ ok: true, text: success });
      setMode({ kind: 'list' });
      load();
    } catch (e) {
      setNotice({ ok: false, text: errorText(e) });
    }
  }

  function toggleActive(user: UserSummary) {
    const action = user.isActive ? 'deactivate' : 'activate';
    if (user.isActive && !window.confirm(t('confirmDeactivate', { name: user.fullName }))) return;
    void run(
      () => api(`/users/${user.id}/${action}`, { method: 'POST' }),
      user.isActive ? t('deactivated') : t('activated'),
    );
  }

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {mode.kind === 'list' && can(me, 'users:create') && (
          <button type="button" className="primary" onClick={() => setMode({ kind: 'create' })}>
            {t('add')}
          </button>
        )}
      </div>

      {notice && (
        <p className={notice.ok ? 'success' : 'error'} role="status">
          {notice.text}
        </p>
      )}

      {mode.kind === 'reset' && (
        <ResetPasswordForm
          key={mode.user.id}
          user={mode.user}
          onCancel={() => setMode({ kind: 'list' })}
          onSubmit={(password) =>
            run(
              () => api(`/users/${mode.user.id}/password`, { method: 'POST', body: { password } }),
              t('passwordReset'),
            )
          }
        />
      )}

      {(mode.kind === 'create' || mode.kind === 'edit') && (
        <UserForm
          key={mode.kind === 'edit' ? mode.user.id : 'new'}
          user={mode.kind === 'edit' ? mode.user : undefined}
          onCancel={() => setMode({ kind: 'list' })}
          onSubmit={(body) =>
            mode.kind === 'edit'
              ? run(() => api(`/users/${mode.user.id}`, { method: 'PATCH', body }), t('saved'))
              : run(() => api('/users', { method: 'POST', body }), t('created'))
          }
        />
      )}

      {users === null ? (
        <p className="muted">{t('loading')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('email')}</th>
                <th>{t('roles')}</th>
                <th>{t('branches')}</th>
                <th>{t('status')}</th>
                <th>{t('lastLogin')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className={user.isActive ? '' : 'inactive'}>
                  <td>{user.fullName}</td>
                  <td dir="ltr">{user.email}</td>
                  <td>{list(user.roles.map((role) => tRoles(role)))}</td>
                  <td>
                    {user.roles.some((r) => r === 'ADMINISTRATOR' || r === 'MANAGEMENT')
                      ? t('allBranches')
                      : list(user.branchIds.map(branchName))}
                  </td>
                  <td>{user.isActive ? t('active') : t('inactive')}</td>
                  <td>
                    {user.lastLoginAt
                      ? new Date(user.lastLoginAt).toLocaleString(locale)
                      : t('never')}
                  </td>
                  <td>
                    {can(me, 'users:update') && (
                      <div className="actions">
                        <button type="button" onClick={() => setMode({ kind: 'edit', user })}>
                          {t('edit')}
                        </button>
                        <button type="button" onClick={() => setMode({ kind: 'reset', user })}>
                          {t('resetPassword')}
                        </button>
                        {user.id !== me.id && (
                          <button type="button" onClick={() => toggleActive(user)}>
                            {user.isActive ? t('deactivate') : t('activate')}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface UserFormBody {
  email?: string;
  password?: string;
  fullName: string;
  preferredLocale: Locale;
  roles: Role[];
  branchIds: string[];
}

function UserForm({
  user,
  onCancel,
  onSubmit,
}: {
  user?: UserSummary;
  onCancel: () => void;
  onSubmit: (body: UserFormBody) => Promise<void>;
}) {
  const t = useTranslations('Users');
  const tRoles = useTranslations('Roles');
  const locale = useLocale();
  const me = useMe();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: UserFormBody = {
      fullName: field(form, 'fullName'),
      preferredLocale: form.get('preferredLocale') === 'en' ? 'en' : 'ar',
      roles: ROLES.filter((role) => form.getAll('roles').includes(role)),
      branchIds: form.getAll('branchIds').map(String),
    };
    if (!user) {
      body.email = field(form, 'email');
      body.password = field(form, 'password');
    }
    setBusy(true);
    await onSubmit(body);
    setBusy(false);
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h2>{user ? t('editTitle', { name: user.fullName }) : t('add')}</h2>
      <div className="grid">
        <label className="field">
          <span>{t('name')}</span>
          <input name="fullName" defaultValue={user?.fullName} required maxLength={200} />
        </label>
        {!user && (
          <>
            <label className="field">
              <span>{t('email')}</span>
              <input name="email" type="email" required dir="ltr" />
            </label>
            <label className="field">
              <span>{t('password', { min: MIN_PASSWORD_LENGTH })}</span>
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                maxLength={MAX_PASSWORD_LENGTH}
                required
              />
            </label>
          </>
        )}
        <label className="field">
          <span>{t('language')}</span>
          <select name="preferredLocale" defaultValue={user?.preferredLocale ?? 'ar'}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {t(`locale_${l}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset>
        <legend>{t('roles')}</legend>
        <div className="checks">
          {ROLES.map((role) => (
            <label key={role}>
              <input
                type="checkbox"
                name="roles"
                value={role}
                defaultChecked={user?.roles.includes(role)}
              />
              {tRoles(role)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>{t('branches')}</legend>
        <p className="muted">{t('branchesHint')}</p>
        <div className="checks">
          {me.branches.map((branch) => (
            <label key={branch.id}>
              <input
                type="checkbox"
                name="branchIds"
                value={branch.id}
                defaultChecked={user?.branchIds.includes(branch.id)}
              />
              {locale === 'ar' ? branch.nameAr : branch.nameEn}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {t('save')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}

/** In-app reset with a masked, confirmed password (never window.prompt). */
function ResetPasswordForm({
  user,
  onCancel,
  onSubmit,
}: {
  user: UserSummary;
  onCancel: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const t = useTranslations('Users');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = field(form, 'password');
    if (password !== field(form, 'confirmPassword')) {
      setError(t('passwordMismatch'));
      return;
    }
    setError(null);
    setBusy(true);
    await onSubmit(password);
    setBusy(false);
  }

  return (
    <form className="card stack narrow" onSubmit={(e) => void submit(e)}>
      <h2>{t('resetTitle', { name: user.fullName })}</h2>
      <label className="field">
        <span>{t('password', { min: MIN_PASSWORD_LENGTH })}</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={MAX_PASSWORD_LENGTH}
          required
        />
      </label>
      <label className="field">
        <span>{t('confirmPassword')}</span>
        <input
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={MAX_PASSWORD_LENGTH}
          required
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {t('resetPassword')}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}
