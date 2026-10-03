'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useMe } from './StaffShell';

export function Dashboard() {
  const t = useTranslations('Dashboard');
  const tRoles = useTranslations('Roles');
  const locale = useLocale();
  const me = useMe();
  const list = new Intl.ListFormat(locale);

  return (
    <section className="stack">
      <h1>{t('welcome', { name: me.fullName })}</h1>
      <p>
        <strong>{t('roles')}: </strong>
        {list.format(me.roles.map((role) => tRoles(role)))}
      </p>
      <p>
        <strong>{t('branches')}: </strong>
        {me.allBranches
          ? t('allBranches')
          : list.format(me.branches.map((b) => (locale === 'ar' ? b.nameAr : b.nameEn)))}
      </p>
      <p className="muted">{t('comingSoon')}</p>
    </section>
  );
}
