'use client';

import type { AccessCatalogDto, BranchAccessDto, Permission } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { samePermissions } from '@/lib/access';
import { api } from '@/lib/api';
import {
  type AccessNotice,
  NoticeLine,
  PermissionPicker,
  useAccessLabels,
  useAccessNotice,
} from './AccessCommon';

/** The branch picker shared by the Branches and Delegation tabs. */
export function BranchSelect({
  catalog,
  value,
  onChange,
}: {
  catalog: AccessCatalogDto;
  value: string;
  onChange: (id: string) => void;
}) {
  const t = useTranslations('Access');
  const { name } = useAccessLabels();
  return (
    <label className="field inline">
      <span>{t('branch')}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('chooseBranch')}</option>
        {catalog.branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.code} · {name(b)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Loads GET /access-control/branches/:id for the chosen branch. */
export function useBranchAccess(branchId: string) {
  const failure = useAccessNotice();
  const [branch, setBranch] = useState<BranchAccessDto | null>(null);
  const [loadNotice, setLoadNotice] = useState<AccessNotice | null>(null);
  const load = useCallback(() => {
    if (!branchId) return;
    api<BranchAccessDto>(`/access-control/branches/${branchId}`)
      .then((b) => {
        setBranch(b);
        setLoadNotice(null);
      })
      .catch((e: unknown) => setLoadNotice(failure(e)));
  }, [branchId, failure]);
  useEffect(load, [load]);
  // A response for another branch (the picker moved on) is not shown.
  const current = branch && branch.branchId === branchId ? branch : null;
  return { branch: current, setBranch, load, loadNotice };
}

/** Branches: the permissions blocked in a branch, and who works there. */
export function BranchesTab({
  catalog,
  canEdit,
  onChanged,
}: {
  catalog: AccessCatalogDto;
  canEdit: boolean;
  /** After a save: the catalog is read again at the new version (F118-3). */
  onChanged?: () => void;
}) {
  const t = useTranslations('Access');
  const tRoles = useTranslations('Roles');
  const { list } = useAccessLabels();
  const [branchId, setBranchId] = useState('');
  const { branch, setBranch, load, loadNotice } = useBranchAccess(branchId);
  const [blocked, setBlocked] = useState<Permission[] | null>(null);
  const [notice, setNotice] = useState<AccessNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const failure = useAccessNotice();
  const value = blocked ?? branch?.blocked ?? [];

  function choose(id: string) {
    setBranchId(id);
    setBlocked(null);
    setNotice(null);
  }

  async function save() {
    if (!branch) return;
    setBusy(true);
    setNotice(null);
    try {
      const next = await api<BranchAccessDto>(
        `/access-control/branches/${branch.branchId}/blocked`,
        {
          method: 'PUT',
          body: { permissions: value, expectedVersion: branch.version },
        },
      );
      setBranch(next);
      setBlocked(null);
      setNotice({ ok: true, text: t('saved') });
      onChanged?.();
    } catch (e) {
      setNotice(failure(e));
    }
    setBusy(false);
  }

  function reload() {
    setBlocked(null);
    setNotice(null);
    load();
  }

  return (
    <div className="stack">
      <BranchSelect catalog={catalog} value={branchId} onChange={choose} />
      <NoticeLine notice={loadNotice ?? notice} onReload={reload} />
      {branchId && !branch && !loadNotice && <p className="muted">{t('loading')}</p>}
      {branch && (
        <>
          <section className="card stack">
            <h2>{t('blockedTitle')}</h2>
            <p className="muted">{t('blockedHint')}</p>
            <PermissionPicker
              label={t('blockedTitle')}
              modules={catalog.modules}
              offered={canEdit ? catalog.grantable : []}
              value={value}
              disabled={!canEdit || busy}
              onChange={setBlocked}
            />
            {canEdit && (
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || samePermissions(value, branch.blocked)}
                  onClick={() => void save()}
                >
                  {t('save')}
                </button>
              </div>
            )}
          </section>
          <section className="card stack">
            <h2>{t('branchPeople')}</h2>
            {branch.people.length === 0 ? (
              <p className="muted">{t('noPeople')}</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('person')}</th>
                      <th>{t('roles')}</th>
                      <th>{t('status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {branch.people.map((p) => (
                      <tr key={p.userId} className={p.isActive ? '' : 'inactive'}>
                        <td>{p.fullName}</td>
                        <td>{list(p.roles.map((r) => tRoles(r)))}</td>
                        <td>{p.isActive ? t('active') : t('inactive')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
