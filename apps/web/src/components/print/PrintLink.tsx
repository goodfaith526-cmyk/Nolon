'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { icons } from '../Icons';

/** Opens a printout (/print/...) in a new tab, from the screen it belongs to. */
export function PrintLink({
  href,
  label,
  small,
}: {
  href: string;
  label?: string;
  small?: boolean;
}) {
  const t = useTranslations('Print');
  return (
    <Link
      href={`/print${href}`}
      target="_blank"
      rel="noopener"
      className={small ? 'button small' : 'button'}
    >
      {icons.print}
      <span>{label ?? t('print')}</span>
    </Link>
  );
}
