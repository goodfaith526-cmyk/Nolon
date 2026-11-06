'use client';

import type { ShipmentDto } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { shipmentProgress } from './milestones';

/**
 * The top of a shipment page (screen review 2026-11-06): where the shipment stands on its few
 * milestones, then the facts staff look for first (last update, where it is, when it arrives,
 * what comes next). Every value is read from the shipment as the API sent it.
 */
export function ShipmentProgress({
  shipment,
  locationName,
}: {
  shipment: ShipmentDto;
  locationName: (id: string) => string;
}) {
  const t = useTranslations('Shipments');
  const te = useTranslations('Enums');
  const locale = useLocale();
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const progress = shipmentProgress(shipment);
  const last = shipment.events.at(-1);
  const next = shipment.actions.transitions[0];

  return (
    <div className="panel shipment-progress">
      <ol className="milestones" aria-label={t('progressLabel')}>
        {progress.steps.map((step) => (
          <li
            key={step.milestone}
            className={`milestone ${step.state}${
              step.state === 'current' && progress.stopped ? ` stopped-${progress.stopped}` : ''
            }`}
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <span className="milestone-dot" aria-hidden="true" />
            <span className="milestone-label">{t(`milestone_${step.milestone}`)}</span>
            <span className="milestone-date">
              {step.reachedAt ? day.format(new Date(step.reachedAt)) : '\u00a0'}
            </span>
          </li>
        ))}
      </ol>
      {progress.stopped && (
        <p className={`milestone-stopped ${progress.stopped}`}>
          {t(progress.stopped === 'ON_HOLD' ? 'stoppedHold' : 'stoppedCancelled')}
        </p>
      )}
      <dl className="key-facts">
        <div>
          <dt>{t('lastUpdate')}</dt>
          <dd>
            {last ? (
              <>
                {te(`shipment_${last.status}`)}
                <span className="muted"> · {dateTime.format(new Date(last.occurredAt))}</span>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt>{t('currentLocation')}</dt>
          <dd>{shipment.currentLocationId ? locationName(shipment.currentLocationId) : '—'}</dd>
        </div>
        <div>
          <dt>{t('eta')}</dt>
          <dd dir="ltr">{shipment.eta ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('nextStep')}</dt>
          <dd>{next ? te(`shipment_${next}`) : '—'}</dd>
        </div>
      </dl>
    </div>
  );
}
