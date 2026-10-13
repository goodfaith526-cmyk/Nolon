'use client';

import type { DraftPriceSource } from '@nolon/shared';
import { useTranslations } from 'next-intl';

/** Under a draft line's unit price: typed by a person, or the system price and where from. */
export function DraftPriceSourceNote({ source }: { source: DraftPriceSource | undefined }) {
  const t = useTranslations('Drafts');
  if (!source) return null;
  const label = {
    TYPED: t('priceTyped'),
    QUOTATION: t('priceQuotation'),
    RATE_CARD: t('priceRateCard'),
  }[source.source];
  return (
    <div className="muted">
      <small>{label}</small>
    </div>
  );
}
