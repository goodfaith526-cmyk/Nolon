'use client';

import { useLocale, useTranslations } from 'next-intl';
import { icons } from '../Icons';
import { openStandaloneWindow } from './open-window';
import type { StandaloneRecord } from './standalone-links';

/**
 * A visible "open in its own window" button for one shipment or booking (icon only in tables, icon
 * and text on a record page), so the window is one click away wherever the record is listed.
 */
export function StandaloneWindowButton({
  record,
  iconOnly,
}: {
  record: StandaloneRecord;
  iconOnly?: boolean;
}) {
  const t = useTranslations('Common');
  const locale = useLocale();
  const label = t('openStandalone');
  return (
    <button
      type="button"
      className={iconOnly ? 'ghost icon-button window-button' : undefined}
      title={label}
      aria-label={iconOnly ? label : undefined}
      onClick={() => openStandaloneWindow(locale, record)}
    >
      {icons.window}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
}
