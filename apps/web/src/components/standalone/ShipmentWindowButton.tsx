'use client';

import { useLocale, useTranslations } from 'next-intl';
import { icons } from '../Icons';
import { openShipmentWindow } from './open-window';

/**
 * A visible "open in its own window" button for one shipment (icon only in tables, icon and text
 * on the shipment page), so the window is one click away wherever a shipment is listed.
 */
export function ShipmentWindowButton({
  shipmentId,
  iconOnly,
}: {
  shipmentId: string;
  iconOnly?: boolean;
}) {
  const t = useTranslations('Shipments');
  const locale = useLocale();
  const label = t('openStandalone');
  return (
    <button
      type="button"
      className={iconOnly ? 'ghost icon-button window-button' : undefined}
      title={label}
      aria-label={iconOnly ? label : undefined}
      onClick={() => openShipmentWindow(locale, shipmentId)}
    >
      {icons.window}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
}
