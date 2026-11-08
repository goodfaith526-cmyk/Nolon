'use client';

import type { PalletCarrierDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

/** The container or trip carrying a pallet, linked to its page. */
export function CarrierLabel({ carrier }: { carrier: PalletCarrierDto }) {
  const t = useTranslations('Pallets');
  const href =
    carrier.kind === 'CONTAINER' ? `/consolidations/${carrier.id}` : `/trips/${carrier.id}`;
  return (
    <Link href={href}>
      {carrier.kind === 'CONTAINER'
        ? t('container', { number: carrier.number })
        : t('trip', { number: carrier.number })}
    </Link>
  );
}
