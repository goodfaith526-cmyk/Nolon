'use client';

import {
  PERMISSION_MODULES,
  type DelegatedPersonDto,
  type MyDelegationDto,
  type Permission,
  type SetDelegatedAccessRequest,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  type AccessNotice,
  NoticeLine,
  PermissionPicker,
  PermissionSummary,
  useAccessLabels,
  useAccessNotice,
} from './AccessCommon';

/**
 * The branch-permissions screen of a person the owner delegated to (plan 03, section 6): the
 * people of their branch, and what this delegation gave them. What the owner gave is read only.
 */
/** The form's fields; the section adds the version the screen was read at (F118-3). */
type DelegatedFields = Omit<SetDelegatedAccessRequest, 'expectedVersion'>;

export function BranchPermissions() {
  const t = useTranslations('Access');
  const failure = useAccessNotice();
  const [mine, setMine] = useState<MyDelegationDto[] | null>(null);
  const [notice, setNotice] = useState<AccessNotice | null>(null);

  const load = useCallback(() => {
    api<MyDelegationDto[]>('/branch-access')
      .then((list) => {
        setMine(list);
        setNotice(null);
      })
      .catch((e: unknown) => setNotice(failure(e)));
  }, [failure]);
  useEffect(load, [load]);

  function replace(delegationId: string, person: DelegatedPersonDto) {
    setMine(
      (list) =>
        list?.map((d) =>
          d.delegation.id === delegationId
            ? {
                ...d,
                people: d.people.map((p) => (p.userId === person.userId ? person : p)),
              }
            : d,
        ) ?? null,
    );
  }

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('branchTitle')}</h1>
      </div>
      <p className="muted">{t('branchHint')}</p>
      <NoticeLine notice={notice} onReload={load} />
      {mine === null
        ? !notice && <p className="muted">{t('loading')}</p>
        : mine.length === 0 && <p className="muted">{t('noOwnDelegations')}</p>}
      {mine?.map((d) => (
        <DelegationSection
          key={d.delegation.id}
          mine={d}
          onSaved={(person) => replace(d.delegation.id, person)}
          onReload={load}
        />
      ))}
    </section>
  );
}

function DelegationSection({
  mine,
  onSaved,
  onReload,
}: {
  mine: MyDelegationDto;
  onSaved: (person: DelegatedPersonDto) => void;
  onReload: () => void;
}) {
  const t = useTranslations('Access');
  const tRoles = useTranslations('Roles');
  const { name, list, teamName, permissionLabel } = useAccessLabels();
  const failure = useAccessNotice();
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<AccessNotice | null>(null);
  const { delegation, branch } = mine;
  const teams = mine.teams.filter((x) => x.isActive && !x.restricted);
  const teamLabel = (id: string) => teamName(mine.teams, id);

  async function save(userId: string, body: DelegatedFields) {
    setNotice(null);
    try {
      const person = await api<DelegatedPersonDto>(
        `/branch-access/${delegation.id}/people/${userId}`,
        { method: 'PUT', body: { ...body, expectedVersion: mine.version } },
      );
      onSaved(person);
      setEditing(null);
      setNotice({ ok: true, text: t('saved') });
      // The save raised the version: read the screen again before the next change (F118-3).
      onReload();
    } catch (e) {
      setNotice(failure(e));
    }
  }

  return (
    <section className="card stack">
      <h2>
        {branch.code} · {name(branch)}
      </h2>
      <details>
        <summary>{t('yourCeiling')}</summary>
        <PermissionSummary modules={PERMISSION_MODULES} permissions={delegation.permissions} />
      </details>
      <NoticeLine
        notice={notice}
        onReload={() => {
          setNotice(null);
          setEditing(null);
          onReload();
        }}
      />
      {mine.people.length === 0 ? (
        <p className="muted">{t('noPeople')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('person')}</th>
                <th>{t('roles')}</th>
                <th>{t('fromOwner')}</th>
                <th>{t('fromYou')}</th>
                <th>{t('effectiveCount')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mine.people.map((p) => (
                <tr key={p.userId} className={p.isActive ? '' : 'inactive'}>
                  <td>{p.fullName}</td>
                  <td>{list(p.roles.map((r) => tRoles(r)))}</td>
                  <td className="wrap">
                    {list([
                      ...p.owner.teamIds.map(teamLabel),
                      ...p.owner.allow.map(permissionLabel),
                      ...p.owner.deny.map((x) =>
                        t('deniedItem', { permission: permissionLabel(x) }),
                      ),
                    ])}
                  </td>
                  <td className="wrap">
                    {list([
                      ...p.delegated.teamIds.map(teamLabel),
                      ...p.delegated.allow.map(permissionLabel),
                    ])}
                  </td>
                  <td>{p.effective.length}</td>
                  <td>
                    {p.editable ? (
                      <button
                        type="button"
                        disabled={editing !== null}
                        onClick={() => setEditing(p.userId)}
                      >
                        {t('edit')}
                      </button>
                    ) : (
                      <span className="muted">{t('notEditable')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mine.people
        .filter((p) => p.userId === editing && p.editable)
        .map((p) => (
          <DelegatedForm
            key={p.userId}
            person={p}
            teams={teams}
            ceiling={delegation.permissions}
            onCancel={() => setEditing(null)}
            onSubmit={(body) => save(p.userId, body)}
          />
        ))}
    </section>
  );
}

function DelegatedForm({
  person,
  teams,
  ceiling,
  onCancel,
  onSubmit,
}: {
  person: DelegatedPersonDto;
  teams: MyDelegationDto['teams'];
  ceiling: Permission[];
  onCancel: () => void;
  onSubmit: (body: DelegatedFields) => Promise<void>;
}) {
  const t = useTranslations('Access');
  const { name } = useAccessLabels();
  const [teamIds, setTeamIds] = useState<string[]>(person.delegated.teamIds);
  const [allow, setAllow] = useState<Permission[]>(person.delegated.allow);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    await onSubmit({ teamIds, allow });
    setBusy(false);
  }

  return (
    <div className="stack">
      <h3>{t('editPerson', { name: person.fullName })}</h3>
      <p className="muted">{t('delegatedHint')}</p>
      <fieldset>
        <legend>{t('branchTeams')}</legend>
        {teams.length === 0 ? (
          <p className="muted">{t('none')}</p>
        ) : (
          <div className="checks">
            {teams.map((x) => (
              <label key={x.id}>
                <input
                  type="checkbox"
                  name="teamIds"
                  value={x.id}
                  checked={teamIds.includes(x.id)}
                  disabled={busy}
                  onChange={(e) =>
                    setTeamIds(
                      e.target.checked ? [...teamIds, x.id] : teamIds.filter((id) => id !== x.id),
                    )
                  }
                />
                {name(x)}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <h3>{t('added')}</h3>
      <PermissionPicker
        label={t('added')}
        modules={PERMISSION_MODULES}
        offered={ceiling}
        value={allow}
        disabled={busy}
        onChange={setAllow}
      />
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {t('save')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}
