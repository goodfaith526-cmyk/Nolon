'use client';

import type {
  AccessCatalogDto,
  CreateDelegationRequest,
  DelegationChangeDto,
  DelegationDto,
  DroppedGrantDto,
  Permission,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { removedPermissions } from '@/lib/access';
import { api } from '@/lib/api';
import {
  type AccessNotice,
  NoticeLine,
  PermissionPicker,
  PermissionSummary,
  useAccessLabels,
  useAccessNotice,
} from './AccessCommon';
import { BranchSelect, useBranchAccess } from './BranchesTab';

/** A change waiting for the owner's confirmation, with what it would drop. */
interface Pending {
  delegation: DelegationDto;
  /** The new ceiling; null revokes the delegation. */
  permissions: Permission[] | null;
  dropped: DroppedGrantDto[];
  /** The preview's version: the change applies only if nothing changed since (F118-3). */
  version: string;
}

/** Delegation: per branch, who may hand out what; a smaller ceiling or a revocation is previewed. */
export function DelegationsTab({
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
  const locale = useLocale();
  const failure = useAccessNotice();
  const [branchId, setBranchId] = useState('');
  const { branch, load, loadNotice } = useBranchAccess(branchId);
  const [notice, setNotice] = useState<AccessNotice | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  function choose(id: string) {
    setBranchId(id);
    setEditing(null);
    setPending(null);
    setNotice(null);
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice({ ok: true, text: success });
      setEditing(null);
      setPending(null);
      load();
      onChanged?.();
    } catch (e) {
      setNotice(failure(e));
    }
    setBusy(false);
  }

  /** A ceiling that only grows applies at once; one that loses any permission is previewed. */
  async function change(delegation: DelegationDto, permissions: Permission[] | null) {
    const shrinks =
      permissions === null || removedPermissions(delegation.permissions, permissions).length > 0;
    if (!shrinks) {
      if (!branch) return;
      await run(() => setCeiling(delegation, permissions, branch.version), t('saved'));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const preview = await api<DelegationChangeDto>(
        `/access-control/delegations/${delegation.id}/preview`,
        { method: 'POST', body: { permissions } },
      );
      setPending({ delegation, permissions, dropped: preview.dropped, version: preview.version });
    } catch (e) {
      setNotice(failure(e));
    }
    setBusy(false);
  }

  function setCeiling(delegation: DelegationDto, permissions: Permission[], version: string) {
    return api<DelegationChangeDto>(`/access-control/delegations/${delegation.id}/permissions`, {
      method: 'PUT',
      body: { permissions, expectedVersion: version },
    });
  }

  function confirm(p: Pending) {
    const { permissions } = p;
    void run(
      () =>
        permissions === null
          ? api<DelegationChangeDto>(`/access-control/delegations/${p.delegation.id}/revoke`, {
              method: 'POST',
              body: { expectedVersion: p.version },
            })
          : setCeiling(p.delegation, permissions, p.version),
      permissions === null ? t('revoked') : t('saved'),
    );
  }

  function reload() {
    setPending(null);
    setEditing(null);
    setNotice(null);
    load();
  }

  const taken = new Set(branch?.delegations.map((d) => d.delegate.userId));
  const candidates = branch?.people.filter((p) => p.isActive && !taken.has(p.userId)) ?? [];

  return (
    <div className="stack">
      <p className="muted">{t('delegationHint')}</p>
      <BranchSelect catalog={catalog} value={branchId} onChange={choose} />
      <NoticeLine notice={loadNotice ?? notice} onReload={reload} />
      {branchId && !branch && !loadNotice && <p className="muted">{t('loading')}</p>}

      {pending && (
        <ConfirmDrop
          pending={pending}
          catalog={catalog}
          busy={busy}
          onConfirm={() => confirm(pending)}
          onCancel={() => setPending(null)}
        />
      )}

      {branch && (
        <>
          {canEdit && editing !== 'new' && (
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={candidates.length === 0}
                onClick={() => setEditing('new')}
              >
                {t('addDelegation')}
              </button>
            </div>
          )}
          {editing === 'new' && (
            <NewDelegationForm
              catalog={catalog}
              people={candidates}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSubmit={(body) =>
                run(
                  () =>
                    api<DelegationDto>('/access-control/delegations', {
                      method: 'POST',
                      body: {
                        ...body,
                        branchId: branch.branchId,
                        expectedVersion: branch.version,
                      },
                    }),
                  t('delegationCreated'),
                )
              }
            />
          )}
          {branch.delegations.length === 0 && <p className="muted">{t('noDelegations')}</p>}
          {branch.delegations.map((d) => (
            <section key={d.id} className="card stack">
              <div className="row">
                <h2>{d.delegate.fullName}</h2>
                <span className="muted">
                  {t('delegatedOn', { date: date.format(new Date(d.createdAt)) })} ·{' '}
                  {t('grantedCount', { count: d.grantedCount })}
                </span>
              </div>
              {editing === d.id ? (
                <CeilingEditor
                  key={d.permissions.join(',')}
                  catalog={catalog}
                  initial={d.permissions}
                  busy={busy || pending !== null}
                  onCancel={() => setEditing(null)}
                  onSubmit={(permissions) => change(d, permissions)}
                />
              ) : (
                <PermissionSummary modules={catalog.modules} permissions={d.permissions} />
              )}
              {canEdit && editing !== d.id && (
                <div className="actions">
                  <button
                    type="button"
                    disabled={busy || pending !== null}
                    onClick={() => setEditing(d.id)}
                  >
                    {t('changeCeiling')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || pending !== null}
                    onClick={() => void change(d, null)}
                  >
                    {t('revoke')}
                  </button>
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function CeilingEditor({
  catalog,
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  catalog: AccessCatalogDto;
  initial: Permission[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (permissions: Permission[]) => Promise<void>;
}) {
  const t = useTranslations('Access');
  const [permissions, setPermissions] = useState<Permission[]>(initial);
  return (
    <div className="stack">
      <PermissionPicker
        label={t('ceiling')}
        modules={catalog.modules}
        offered={catalog.grantable}
        value={permissions}
        disabled={busy}
        onChange={setPermissions}
      />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || permissions.length === 0}
          onClick={() => void onSubmit(permissions)}
        >
          {t('save')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

function NewDelegationForm({
  catalog,
  people,
  busy,
  onCancel,
  onSubmit,
}: {
  catalog: AccessCatalogDto;
  people: { userId: string; fullName: string }[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Omit<CreateDelegationRequest, 'branchId' | 'expectedVersion'>) => Promise<void>;
}) {
  const t = useTranslations('Access');
  const [delegateUserId, setDelegate] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  return (
    <section className="card stack">
      <h2>{t('addDelegation')}</h2>
      <label className="field inline">
        <span>{t('delegate')}</span>
        <select value={delegateUserId} onChange={(e) => setDelegate(e.target.value)}>
          <option value="">{t('choosePerson')}</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.fullName}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">{t('ceilingHint')}</p>
      <PermissionPicker
        label={t('ceiling')}
        modules={catalog.modules}
        offered={catalog.grantable}
        value={permissions}
        disabled={busy}
        onChange={setPermissions}
      />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !delegateUserId || permissions.length === 0}
          onClick={() => void onSubmit({ delegateUserId, permissions })}
        >
          {t('create')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </section>
  );
}

/** What a smaller ceiling or a revocation would drop, before it is applied. */
function ConfirmDrop({
  pending,
  catalog,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: Pending;
  catalog: AccessCatalogDto;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('Access');
  const { permissionLabel, teamName } = useAccessLabels();
  const revoke = pending.permissions === null;
  return (
    <section className="card stack" role="alertdialog" aria-labelledby="access-confirm-title">
      <h2 id="access-confirm-title">
        {revoke
          ? t('confirmRevokeTitle', { name: pending.delegation.delegate.fullName })
          : t('confirmShrinkTitle', { name: pending.delegation.delegate.fullName })}
      </h2>
      {pending.dropped.length === 0 ? (
        <p>{t('nothingDrops')}</p>
      ) : (
        <>
          <p>{t('willDrop', { count: pending.dropped.length })}</p>
          <ul>
            {pending.dropped.map((d, i) => (
              <li key={`${d.userId}-${d.permission ?? ''}-${d.teamId ?? ''}-${i}`}>
                {d.fullName}:{' '}
                {d.permission
                  ? permissionLabel(d.permission)
                  : d.teamId
                    ? t('teamMembership', { team: teamName(catalog.teams, d.teamId) })
                    : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
          {revoke ? t('confirmRevoke') : t('confirmShrink')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </section>
  );
}
