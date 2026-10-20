'use client';

import { useTranslations } from 'next-intl';
import { AgentClients } from './AgentClients';
import { ApiKeys } from './ApiKeys';
import { can, useMe } from './StaffShell';

/**
 * The API keys page: two separate kinds of access, each in its own section. Customer Service API
 * keys (the /cs/* routes, a key per client) and the platforms that sign staff in to the assistant
 * (delegated sign-in, no key).
 */
export function ApiAccess() {
  const t = useTranslations('ApiAccess');
  const tc = useTranslations('Common');
  const me = useMe();
  if (!can(me, 'users:view')) return <p className="error">{tc('noAccess')}</p>;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('hint')}</p>
        </div>
      </div>
      <ApiKeys />
      <AgentClients />
    </div>
  );
}
