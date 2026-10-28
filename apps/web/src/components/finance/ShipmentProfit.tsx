'use client';

import type { ShipmentExpectedDto, ShipmentProfitDto, ShipmentProfitViewDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from './common';

/**
 * The shipment's profit (business model plan 6.2): two separate columns, the expected margin
 * from the rate cards it is priced from and the actual one from the posted books. Nothing moves
 * from one to the other.
 */
export function ShipmentProfit({ shipmentId }: { shipmentId: string }) {
  const t = useTranslations('ShipmentProfit');
  const { record, notice } = useRecord<ShipmentProfitViewDto>(
    `/reports/shipment-profitability/shipments/${shipmentId}`,
  );
  if (!record) return <Notice notice={notice} />;
  return (
    <div className="grid">
      <section>
        <h3>{t('expected')}</h3>
        <p className="muted">{t('expectedHint')}</p>
        {record.expected ? <Expected expected={record.expected} /> : <p>{t('noExpected')}</p>}
      </section>
      <section>
        <h3>{t('actual')}</h3>
        <p className="muted">{t('actualHint')}</p>
        {record.actual ? <Actual actual={record.actual} /> : <p>{t('nothingPosted')}</p>}
      </section>
    </div>
  );
}

function Expected({ expected }: { expected: ShipmentExpectedDto }) {
  const t = useTranslations('ShipmentProfit');
  const tc = useTranslations('RateCosts');
  return (
    <>
      <p>{t(`source_${expected.source}`)}</p>
      <table>
        <thead>
          <tr>
            <th>{t('charge')}</th>
            <th>{t('quantity')}</th>
            <th>{tc('linePrice')}</th>
            <th>{tc('expectedMargin')}</th>
          </tr>
        </thead>
        <tbody>
          {expected.cards.map((c) => (
            <tr key={`${c.chargeTypeCode}-${c.rateCardId}`}>
              <td dir="ltr">{c.chargeTypeCode}</td>
              <td dir="ltr">{c.quantity ?? '—'}</td>
              <td>
                <Money value={c.price} currency={c.currency} />
              </td>
              <td>
                {c.expectedMargin !== null ? (
                  <Money value={c.expectedMargin} currency={c.currency} />
                ) : (
                  tc('incomplete', {
                    missing: c.missing.map((m) => tc(`component_${m}`)).join('، '),
                  })
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {expected.gaps.map((g) => (
        <p key={`${g.chargeTypeCode}-${g.reason}`} className="muted">
          {t(`gap_${g.reason}`, { charge: g.chargeTypeCode })}
        </p>
      ))}
      <p>
        <strong>{t('expectedTotal')}: </strong>
        {expected.expectedMargin !== null && expected.currency !== null ? (
          <Money value={expected.expectedMargin} currency={expected.currency} />
        ) : (
          t('expectedIncomplete')
        )}
      </p>
    </>
  );
}

function Actual({ actual }: { actual: ShipmentProfitDto }) {
  const t = useTranslations('ShipmentProfit');
  const tr = useTranslations('Reports');
  const te = useTranslations('Enums');
  return (
    <>
      <dl className="details">
        <dt>{t('revenue')}</dt>
        <dd>
          <Money value={actual.revenueUsd} currency="USD" />
        </dd>
        <dt>{t('cost')}</dt>
        <dd>
          <Money value={actual.costUsd} currency="USD" />
        </dd>
        <dt>{t('margin')}</dt>
        <dd>
          <Money value={actual.marginUsd} currency="USD" />
          {actual.marginPercent !== null && <span dir="ltr"> ({actual.marginPercent}%)</span>}
        </dd>
      </dl>
      {actual.incompleteReasons.length > 0 && (
        <p className="muted">
          {tr('notFinal')}:{' '}
          {actual.incompleteReasons
            .map((x) =>
              x === 'MISSING_COST'
                ? tr('notFinal_MISSING_COST', {
                    services: actual.missingCosts.map((s) => te(`service_${s}`)).join('، '),
                  })
                : tr(`notFinal_${x}`),
            )
            .join('، ')}
        </p>
      )}
    </>
  );
}
