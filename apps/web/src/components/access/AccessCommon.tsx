'use client';

import {
  PERMISSION_ACTIONS,
  type AccessTeamDto,
  type Permission,
  type PermissionAction,
  type PermissionModule,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { type AccessErrorKey, accessErrorKey, modulesOf, togglePermission } from '@/lib/access';

/** A message after an action; a stale screen (409) offers to reload. */
export interface AccessNotice {
  ok: boolean;
  text: string;
  stale?: boolean;
}

export function useAccessNotice(): (e: unknown) => AccessNotice {
  const t = useTranslations('Access');
  return useCallback(
    (e: unknown) => {
      const key: AccessErrorKey = accessErrorKey(e);
      return { ok: false, text: t(`error_${key}`), stale: key === 'stale' };
    },
    [t],
  );
}

export function NoticeLine({
  notice,
  onReload,
}: {
  notice: AccessNotice | null;
  onReload?: () => void;
}) {
  const t = useTranslations('Access');
  if (!notice) return null;
  return (
    <div className="actions" role="status">
      <p className={notice.ok ? 'success' : 'error'}>{notice.text}</p>
      {notice.stale && onReload && (
        <button type="button" className="small" onClick={onReload}>
          {t('reload')}
        </button>
      )}
    </div>
  );
}

/** Labels for permissions, modules, actions and teams in the current language. */
export function useAccessLabels() {
  const t = useTranslations('Access');
  const locale = useLocale();
  const moduleLabel = useCallback((m: PermissionModule) => t(`module_${m}`), [t]);
  const actionLabel = useCallback((a: PermissionAction) => t(`action_${a}`), [t]);
  const permissionLabel = useCallback(
    (p: Permission) => {
      const [m, a] = p.split(':') as [PermissionModule, PermissionAction];
      return `${t(`module_${m}`)} · ${t(`action_${a}`)}`;
    },
    [t],
  );
  const name = useCallback(
    (item: { nameAr: string; nameEn: string }) => (locale === 'ar' ? item.nameAr : item.nameEn),
    [locale],
  );
  const teamName = useCallback(
    (teams: readonly AccessTeamDto[], id: string) => {
      const team = teams.find((x) => x.id === id);
      return team ? name(team) : t('unknownTeam');
    },
    [name, t],
  );
  const list = useCallback(
    (items: string[]) =>
      items.length === 0 ? t('none') : new Intl.ListFormat(locale).format(items),
    [locale, t],
  );
  return { moduleLabel, actionLabel, permissionLabel, name, teamName, list };
}

/** A set of permissions, grouped by module: "Customers: View, Create". */
export function PermissionSummary({
  modules,
  permissions,
}: {
  modules: readonly PermissionModule[];
  permissions: readonly Permission[];
}) {
  const t = useTranslations('Access');
  const { moduleLabel, actionLabel, list } = useAccessLabels();
  if (permissions.length === 0) return <span className="muted">{t('none')}</span>;
  const held = new Set(permissions);
  return (
    <ul className="audit-changes">
      {modulesOf(modules, permissions).map((m) => (
        <li key={m}>
          {moduleLabel(m)}:{' '}
          {list(PERMISSION_ACTIONS.filter((a) => held.has(`${m}:${a}`)).map(actionLabel))}
        </li>
      ))}
    </ul>
  );
}

/**
 * Checkboxes, one row per module and one column per action. Only `offered` permissions can be
 * ticked; `locked` ones are shown ticked and cannot change. Modules with nothing offered or held
 * are left out.
 */
export function PermissionPicker({
  modules,
  offered,
  value,
  onChange,
  locked = [],
  disabled = false,
  highlight,
  label,
}: {
  modules: readonly PermissionModule[];
  offered: readonly Permission[];
  value: readonly Permission[];
  onChange: (next: Permission[]) => void;
  locked?: readonly Permission[];
  disabled?: boolean;
  highlight?: PermissionModule | null;
  label: string;
}) {
  const { moduleLabel, actionLabel } = useAccessLabels();
  const offeredSet = new Set(offered);
  const lockedSet = new Set(locked);
  const held = new Set(value);
  const shown = modules.filter((m) =>
    PERMISSION_ACTIONS.some((a) => {
      const p: Permission = `${m}:${a}`;
      return offeredSet.has(p) || lockedSet.has(p) || held.has(p);
    }),
  );
  return (
    <div className="table-wrap">
      <table aria-label={label}>
        <thead>
          <tr>
            <th />
            {PERMISSION_ACTIONS.map((a) => (
              <th key={a}>{actionLabel(a)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((m) => (
            <tr key={m} className={highlight === m ? 'access-highlight' : undefined}>
              <th scope="row">{moduleLabel(m)}</th>
              {PERMISSION_ACTIONS.map((a) => {
                const p: Permission = `${m}:${a}`;
                const isLocked = lockedSet.has(p);
                const canTick = offeredSet.has(p) && !isLocked;
                if (!canTick && !isLocked && !held.has(p)) {
                  return (
                    <td key={a} className="muted">
                      —
                    </td>
                  );
                }
                return (
                  <td key={a}>
                    <input
                      type="checkbox"
                      name="permission"
                      value={p}
                      aria-label={`${moduleLabel(m)} · ${actionLabel(a)}`}
                      checked={isLocked || held.has(p)}
                      disabled={disabled || !canTick}
                      onChange={(e) => onChange(togglePermission(value, p, e.target.checked))}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
