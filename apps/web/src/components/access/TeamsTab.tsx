'use client';

import type {
  AccessCatalogDto,
  AccessTeamDto,
  CreateTeamRequest,
  Permission,
  PermissionModule,
  UpdateTeamRequest,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { accessLevel, moduleDiffers, samePermissions } from '@/lib/access';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import {
  type AccessNotice,
  NoticeLine,
  PermissionPicker,
  useAccessLabels,
  useAccessNotice,
} from './AccessCommon';

/** The forms' fields; the tab adds the catalog's version (F118-3). */
type NewTeamFields = Omit<CreateTeamRequest, 'expectedVersion'>;
type TeamFields = Omit<UpdateTeamRequest, 'expectedVersion'>;

type Selection =
  { kind: 'team'; teamId: string; module: PermissionModule | null } | { kind: 'new' } | null;

/** Teams: modules × teams with the annex letters; a team's five actions per module on click. */
export function TeamsTab({
  catalog,
  canEdit,
  onReload,
}: {
  catalog: AccessCatalogDto;
  canEdit: boolean;
  onReload: () => void;
}) {
  const t = useTranslations('Access');
  const { moduleLabel, name } = useAccessLabels();
  const [selected, setSelected] = useState<Selection>(null);
  const [notice, setNotice] = useState<AccessNotice | null>(null);
  const failure = useAccessNotice();
  const teams = catalog.teams;
  const team = selected?.kind === 'team' ? teams.find((x) => x.id === selected.teamId) : undefined;

  async function run(action: () => Promise<unknown>, success: string, close = false) {
    setNotice(null);
    try {
      await action();
      setNotice({ ok: true, text: success });
      if (close) setSelected(null);
      onReload();
    } catch (e) {
      setNotice(failure(e));
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <p className="muted">{t('teamsHint')}</p>
        {canEdit && (
          <button type="button" className="primary" onClick={() => setSelected({ kind: 'new' })}>
            {t('addTeam')}
          </button>
        )}
      </div>
      <p className="muted">{t('legend')}</p>
      <NoticeLine notice={notice} onReload={onReload} />

      {selected?.kind === 'new' && (
        <NewTeamForm
          teams={teams}
          onCancel={() => setSelected(null)}
          onSubmit={(body) =>
            run(
              () =>
                api<AccessTeamDto>('/access-control/teams', {
                  method: 'POST',
                  body: { ...body, expectedVersion: catalog.version },
                }),
              t('teamCreated'),
              true,
            )
          }
        />
      )}

      {team && selected?.kind === 'team' && (
        <TeamEditor
          key={`${team.id}-${team.permissions.join(',')}-${team.isActive}`}
          team={team}
          catalog={catalog}
          canEdit={canEdit}
          highlight={selected.module}
          onClose={() => setSelected(null)}
          onSave={(permissions) =>
            run(
              () =>
                api<AccessTeamDto>(`/access-control/teams/${team.id}/permissions`, {
                  method: 'PUT',
                  body: { permissions, expectedVersion: catalog.version },
                }),
              t('saved'),
            )
          }
          onUpdate={(body: TeamFields) =>
            run(
              () =>
                api<AccessTeamDto>(`/access-control/teams/${team.id}`, {
                  method: 'PATCH',
                  body: { ...body, expectedVersion: catalog.version },
                }),
              t('saved'),
            )
          }
        />
      )}

      <div className="table-wrap">
        <table className="access-grid">
          <thead>
            <tr>
              <th>{t('module')}</th>
              {teams.map((x) => (
                <th key={x.id} className={x.isActive ? undefined : 'muted'}>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => setSelected({ kind: 'team', teamId: x.id, module: null })}
                  >
                    {name(x)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catalog.modules.map((m) => (
              <tr key={m}>
                <th scope="row">{moduleLabel(m)}</th>
                {teams.map((x) => {
                  const level = accessLevel(x.permissions, m);
                  const changed =
                    x.defaults !== null && moduleDiffers(x.permissions, x.defaults, m);
                  return (
                    <td key={x.id}>
                      <button
                        type="button"
                        className={changed ? 'access-cell changed' : 'access-cell'}
                        title={changed ? t('changed') : undefined}
                        aria-label={`${name(x)} · ${moduleLabel(m)}: ${t(`levelName_${level}`)}`}
                        onClick={() => setSelected({ kind: 'team', teamId: x.id, module: m })}
                      >
                        {t(`level_${level}`)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TeamEditor({
  team,
  catalog,
  canEdit,
  highlight,
  onClose,
  onSave,
  onUpdate,
}: {
  team: AccessTeamDto;
  catalog: AccessCatalogDto;
  canEdit: boolean;
  highlight: PermissionModule | null;
  onClose: () => void;
  onSave: (permissions: Permission[]) => Promise<void>;
  onUpdate: (body: TeamFields) => Promise<void>;
}) {
  const t = useTranslations('Access');
  const { name } = useAccessLabels();
  const [permissions, setPermissions] = useState<Permission[]>(team.permissions);
  const [busy, setBusy] = useState(false);
  const editable = canEdit && !team.restricted;
  const grantable = new Set(catalog.grantable);
  // What the screen cannot offer (users, access control) stays as the team holds it.
  const locked = team.permissions.filter((p) => !grantable.has(p));
  const changed = team.defaults !== null && !samePermissions(team.permissions, team.defaults);
  const dirty = !samePermissions(permissions, team.permissions);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    await action();
    setBusy(false);
  }

  function reset() {
    if (!team.defaults || !window.confirm(t('confirmReset', { name: name(team) }))) return;
    const defaults = team.defaults;
    void act(() => onSave(defaults));
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await act(() => onUpdate({ nameAr: field(form, 'nameAr'), nameEn: field(form, 'nameEn') }));
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2>{name(team)}</h2>
        <span className="actions">
          <span className="badge" dir="ltr">
            {team.code}
          </span>
          {team.systemRole === null && <span className="badge badge-info">{t('addedTeam')}</span>}
          {team.defaults !== null && (
            <span className={changed ? 'badge badge-warn' : 'badge badge-ok'}>
              {changed ? t('changed') : t('default')}
            </span>
          )}
          {!team.isActive && <span className="badge">{t('inactive')}</span>}
        </span>
      </div>
      {team.restricted && <p className="muted">{t('restrictedTeam')}</p>}

      {editable && (
        <form className="grid" onSubmit={(e) => void rename(e)}>
          <label className="field">
            <span>{t('nameAr')}</span>
            <input name="nameAr" defaultValue={team.nameAr} required maxLength={100} dir="rtl" />
          </label>
          <label className="field">
            <span>{t('nameEn')}</span>
            <input name="nameEn" defaultValue={team.nameEn} required maxLength={100} dir="ltr" />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy}>
              {t('rename')}
            </button>
          </div>
        </form>
      )}

      <PermissionPicker
        label={name(team)}
        modules={catalog.modules}
        offered={editable ? catalog.grantable : []}
        value={permissions}
        locked={locked}
        disabled={!editable || busy}
        highlight={highlight}
        onChange={setPermissions}
      />

      <div className="actions">
        {editable && (
          <button
            type="button"
            className="primary"
            disabled={busy || !dirty}
            onClick={() => void act(() => onSave(permissions))}
          >
            {t('save')}
          </button>
        )}
        {editable && changed && (
          <button type="button" disabled={busy} onClick={reset}>
            {t('resetDefault')}
          </button>
        )}
        {canEdit && team.systemRole === null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (team.isActive && !window.confirm(t('confirmDeactivate', { name: name(team) })))
                return;
              void act(() => onUpdate({ isActive: !team.isActive }));
            }}
          >
            {team.isActive ? t('deactivate') : t('activate')}
          </button>
        )}
        <button type="button" onClick={onClose}>
          {t('close')}
        </button>
      </div>
    </div>
  );
}

function NewTeamForm({
  teams,
  onCancel,
  onSubmit,
}: {
  teams: readonly AccessTeamDto[];
  onCancel: () => void;
  onSubmit: (body: NewTeamFields) => Promise<void>;
}) {
  const t = useTranslations('Access');
  const { name } = useAccessLabels();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const copy = field(form, 'copyFrom');
    const body: NewTeamFields = {
      code: field(form, 'code'),
      nameAr: field(form, 'nameAr'),
      nameEn: field(form, 'nameEn'),
      ...(copy ? { copyFromTeamId: copy } : {}),
    };
    setBusy(true);
    await onSubmit(body);
    setBusy(false);
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h2>{t('addTeam')}</h2>
      <div className="grid">
        <label className="field">
          <span>{t('code')}</span>
          <input
            name="code"
            required
            maxLength={40}
            pattern="[A-Z0-9_]+"
            title={t('codeHint')}
            dir="ltr"
          />
        </label>
        <label className="field">
          <span>{t('nameAr')}</span>
          <input name="nameAr" required maxLength={100} dir="rtl" />
        </label>
        <label className="field">
          <span>{t('nameEn')}</span>
          <input name="nameEn" required maxLength={100} dir="ltr" />
        </label>
        <label className="field">
          <span>{t('startFrom')}</span>
          <select name="copyFrom" defaultValue="">
            <option value="">{t('startEmpty')}</option>
            {teams
              .filter((x) => !x.restricted)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {t('copyOf', { name: name(x) })}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p className="muted">{t('codeHint')}</p>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {t('create')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}
