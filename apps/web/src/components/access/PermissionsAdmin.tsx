'use client';

import type { AccessCatalogDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { can, useMe } from '../StaffShell';
import { Tabs } from '../Tabs';
import { type AccessNotice, NoticeLine, useAccessNotice } from './AccessCommon';
import { BranchesTab } from './BranchesTab';
import { DelegationsTab } from './DelegationsTab';
import { LogTab } from './LogTab';
import { PeopleTab } from './PeopleTab';
import { TeamsTab } from './TeamsTab';

/** The owner's permissions screen (plan 03, section 6). The API decides and computes everything. */
export function PermissionsAdmin() {
  const t = useTranslations('Access');
  const me = useMe();
  const failure = useAccessNotice();
  const [catalog, setCatalog] = useState<AccessCatalogDto | null>(null);
  const [notice, setNotice] = useState<AccessNotice | null>(null);
  const allowed = can(me, 'access_control:view');
  const canEdit = can(me, 'access_control:update');

  const load = useCallback(() => {
    if (!allowed) return;
    api<AccessCatalogDto>('/access-control/catalog')
      .then((c) => {
        setCatalog(c);
        setNotice(null);
      })
      .catch((e: unknown) => setNotice(failure(e)));
  }, [allowed, failure]);
  useEffect(load, [load]);

  if (!allowed) return <p className="error">{t('error_noAccess')}</p>;

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
      </div>
      {!canEdit && <p className="muted">{t('readOnly')}</p>}
      <NoticeLine notice={notice} onReload={load} />
      {catalog === null ? (
        !notice && <p className="muted">{t('loading')}</p>
      ) : (
        <Tabs
          label={t('title')}
          tabs={[
            {
              key: 'teams',
              label: t('tabTeams'),
              content: <TeamsTab catalog={catalog} canEdit={canEdit} onReload={load} />,
            },
            {
              key: 'branches',
              label: t('tabBranches'),
              content: <BranchesTab catalog={catalog} canEdit={canEdit} />,
            },
            {
              key: 'people',
              label: t('tabPeople'),
              content: <PeopleTab catalog={catalog} canEdit={canEdit} />,
            },
            {
              key: 'delegation',
              label: t('tabDelegation'),
              content: <DelegationsTab catalog={catalog} canEdit={canEdit} />,
            },
            { key: 'log', label: t('tabLog'), content: <LogTab /> },
          ]}
        />
      )}
    </section>
  );
}
