'use client';

import type {
  AccessCatalogDto,
  AccessSourceDto,
  Permission,
  PersonAccessDto,
  PersonBranchAccessDto,
  SetPersonBranchAccessRequest,
  UserSummary,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  type AccessNotice,
  NoticeLine,
  PermissionPicker,
  useAccessLabels,
  useAccessNotice,
} from './AccessCommon';

/** People: a person's access in each of their branches, with why, and the owner's own rows. */
export function PeopleTab({ catalog, canEdit }: { catalog: AccessCatalogDto; canEdit: boolean }) {
  const t = useTranslations('Access');
  const tRoles = useTranslations('Roles');
  const { name, list, teamName } = useAccessLabels();
  const failure = useAccessNotice();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [userId, setUserId] = useState('');
  const [person, setPerson] = useState<PersonAccessDto | null>(null);
  const [notice, setNotice] = useState<AccessNotice | null>(null);

  useEffect(() => {
    api<UserSummary[]>('/users')
      .then((all) => setUsers([...all].sort((a, b) => a.fullName.localeCompare(b.fullName))))
      .catch((e: unknown) => setNotice(failure(e)));
  }, [failure]);

  const load = useCallback(() => {
    if (!userId) return;
    api<PersonAccessDto>(`/access-control/people/${userId}`)
      .then((p) => {
        setPerson(p);
        setNotice(null);
      })
      .catch((e: unknown) => setNotice(failure(e)));
  }, [userId, failure]);
  useEffect(load, [load]);

  const shown = person && person.userId === userId ? person : null;
  const branchName = (id: string) => {
    const b = catalog.branches.find((x) => x.id === id);
    return b ? `${b.code} · ${name(b)}` : id;
  };
  const roleTeams = (p: PersonAccessDto) =>
    p.roles.map((role) => {
      const team = catalog.teams.find((x) => x.systemRole === role);
      return team ? name(team) : tRoles(role);
    });

  async function save(branchId: string, body: SetPersonBranchAccessRequest) {
    setNotice(null);
    try {
      const next = await api<PersonAccessDto>(
        `/access-control/people/${userId}/branches/${branchId}`,
        { method: 'PUT', body },
      );
      setPerson(next);
      setNotice({ ok: true, text: t('saved') });
    } catch (e) {
      setNotice(failure(e));
    }
  }

  return (
    <div className="stack">
      <label className="field inline">
        <span>{t('person')}</span>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">{users ? t('choosePerson') : t('loading')}</option>
          {users?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.fullName}
              {u.isActive ? '' : ` (${t('inactive')})`}
            </option>
          ))}
        </select>
      </label>
      <NoticeLine notice={notice} onReload={load} />
      {userId && !shown && !notice && <p className="muted">{t('loading')}</p>}
      {shown && (
        <>
          <div className="card stack">
            <h2>{shown.fullName}</h2>
            <p>
              {t('roleTeams')}: {list(roleTeams(shown))}
              {shown.allBranches && ` · ${t('allBranches')}`}
            </p>
            <p className="muted">{t('roleTeamsHint')}</p>
            {shown.restricted && <p className="muted">{t('restrictedPerson')}</p>}
          </div>
          {shown.branches.length === 0 && <p className="muted">{t('noBranches')}</p>}
          {shown.branches.map((b) => (
            <PersonBranch
              key={`${b.branchId}-${JSON.stringify([b.teams, b.allow, b.deny])}`}
              title={branchName(b.branchId)}
              access={b}
              person={shown}
              catalog={catalog}
              canEdit={canEdit}
              teamName={(id) => teamName(catalog.teams, id)}
              onSave={(body) => save(b.branchId, body)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function PersonBranch({
  title,
  access,
  person,
  catalog,
  canEdit,
  teamName,
  onSave,
}: {
  title: string;
  access: PersonBranchAccessDto;
  person: PersonAccessDto;
  catalog: AccessCatalogDto;
  canEdit: boolean;
  teamName: (id: string) => string;
  onSave: (body: SetPersonBranchAccessRequest) => Promise<void>;
}) {
  const t = useTranslations('Access');
  const { list, name, permissionLabel } = useAccessLabels();
  const ownerTeams = access.teams.filter((x) => x.delegationId === null).map((x) => x.teamId);
  const ownerAllow = access.allow.filter((x) => x.delegationId === null).map((x) => x.permission);
  const [editing, setEditing] = useState(false);
  const [teamIds, setTeamIds] = useState<string[]>(ownerTeams);
  const [allow, setAllow] = useState<Permission[]>(ownerAllow);
  const [deny, setDeny] = useState<Permission[]>(access.deny);
  const [busy, setBusy] = useState(false);
  // Teams a person can join in one branch: active, not restricted, not one of their role teams.
  const offeredTeams = catalog.teams.filter(
    (x) =>
      (x.isActive && !x.restricted && !(x.systemRole && person.roles.includes(x.systemRole))) ||
      ownerTeams.includes(x.id),
  );

  function why(sources: AccessSourceDto[]): string {
    return list(
      sources.map((s) => {
        if (s.kind === 'ROLE') return t('whyRole', { team: s.teamId ? teamName(s.teamId) : '' });
        if (s.kind === 'TEAM') return t('whyTeam', { team: s.teamId ? teamName(s.teamId) : '' });
        if (s.kind === 'ADDED') return t('whyAdded');
        return s.teamId ? t('whyDelegatedTeam', { team: teamName(s.teamId) }) : t('whyDelegated');
      }),
    );
  }

  async function submit() {
    setBusy(true);
    await onSave(
      // A restricted person takes no team or added permission: their rows stay as they are.
      person.restricted
        ? { teamIds: ownerTeams, allow: ownerAllow, deny }
        : { teamIds, allow, deny },
    );
    setBusy(false);
  }

  return (
    <section className="card stack">
      <div className="row">
        <h2>{title}</h2>
        {canEdit && !editing && (
          <button type="button" onClick={() => setEditing(true)}>
            {t('edit')}
          </button>
        )}
      </div>
      <dl className="details">
        <dt>{t('branchTeams')}</dt>
        <dd>
          {list(
            access.teams.map((x) =>
              x.delegationId ? `${teamName(x.teamId)} (${t('viaDelegation')})` : teamName(x.teamId),
            ),
          )}
        </dd>
        <dt>{t('added')}</dt>
        <dd>
          {list(
            access.allow.map((x) =>
              x.delegationId
                ? `${permissionLabel(x.permission)} (${t('viaDelegation')})`
                : permissionLabel(x.permission),
            ),
          )}
        </dd>
        <dt>{t('denied')}</dt>
        <dd>{list(access.deny.map(permissionLabel))}</dd>
        <dt>{t('blockedInBranch')}</dt>
        <dd>{list(access.blocked.map(permissionLabel))}</dd>
      </dl>

      <h3>{t('effective')}</h3>
      {access.effective.length === 0 ? (
        <p className="muted">{t('none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('permission')}</th>
                <th>{t('why')}</th>
              </tr>
            </thead>
            <tbody>
              {access.effective.map((e) => (
                <tr key={e.permission}>
                  <td>{permissionLabel(e.permission)}</td>
                  <td>{why(e.sources)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="stack">
          <p className="muted">{t('ownerRowsHint')}</p>
          {!person.restricted && (
            <>
              <fieldset>
                <legend>{t('branchTeams')}</legend>
                <div className="checks">
                  {offeredTeams.map((x) => (
                    <label key={x.id}>
                      <input
                        type="checkbox"
                        name="teamIds"
                        value={x.id}
                        checked={teamIds.includes(x.id)}
                        onChange={(e) =>
                          setTeamIds(
                            e.target.checked
                              ? [...teamIds, x.id]
                              : teamIds.filter((id) => id !== x.id),
                          )
                        }
                      />
                      {name(x)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <h3>{t('added')}</h3>
              <PermissionPicker
                label={t('added')}
                modules={catalog.modules}
                offered={catalog.grantable}
                value={allow}
                disabled={busy}
                onChange={setAllow}
              />
            </>
          )}
          <h3>{t('denied')}</h3>
          <PermissionPicker
            label={t('denied')}
            modules={catalog.modules}
            offered={catalog.grantable}
            value={deny}
            disabled={busy}
            onChange={setDeny}
          />
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
              {t('save')}
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
