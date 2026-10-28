'use client';

import type {
  ContainerCapacityDimensionDto,
  ContainerCapacityDto,
  ContainerFitDto,
  ContainerMeasure,
  DecimalString,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { can, useMe } from '../StaffShell';

/** Amber from this fill (percent), red from 100: the colour only; the API decides what fits. */
const NEAR_FULL = 80;

/** The bar's colour for a fill percent (a decimal string from the API, display only). */
function level(fillPercent: DecimalString | null): 'ok' | 'near' | 'full' | 'none' {
  if (fillPercent === null) return 'none';
  // Display only: the percent is compared, never computed with.
  const value = Number(fillPercent);
  return value >= 100 ? 'full' : value >= NEAR_FULL ? 'near' : 'ok';
}

/** The measures' names as a list in the page's language. */
function useMeasureNames(): (measures: readonly ContainerMeasure[]) => string {
  const t = useTranslations('Consolidations');
  const locale = useLocale();
  return (measures) =>
    new Intl.ListFormat(locale, { type: 'conjunction' }).format(
      measures.map((m) => t(`capacity_${m}`)),
    );
}

/** A container's space: CBM and weight against its type's limits, as the API computes them. */
export function CapacityPanel({ capacity }: { capacity: ContainerCapacityDto }) {
  const t = useTranslations('Consolidations');
  const me = useMe();
  const names = useMeasureNames();
  const measures: ContainerMeasure[] = ['volumeCbm', 'weightKg'];
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>{t('capacitySection')}</h2>
          <p className="muted">{capacity.asOfNow ? t('capacityAsOfNow') : t('capacityHint')}</p>
        </div>
      </div>
      <div className="panel-body stack">
        {measures.map((m) => (
          <Dimension key={m} measure={m} value={capacity[m]} />
        ))}
        {capacity.incomplete.length > 0 && (
          <div className="capacity-incomplete">
            <p>{t('capacityIncomplete')}</p>
            <ul>
              {capacity.incomplete.map((s) => (
                <li key={s.shipmentId}>
                  {can(me, 'shipments:view') ? (
                    <Link href={`/shipments/${s.shipmentId}`} dir="ltr">
                      {s.shipmentNumber}
                    </Link>
                  ) : (
                    <bdi dir="ltr">{s.shipmentNumber}</bdi>
                  )}
                  {': '}
                  {names(s.missing)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Dimension({
  measure,
  value,
}: {
  measure: ContainerMeasure;
  value: ContainerCapacityDimensionDto;
}) {
  const t = useTranslations('Consolidations');
  const unit = t(`unit_${measure}`);
  const state = level(value.fillPercent);
  return (
    <div className={`capacity capacity-${state}`}>
      <div className="capacity-head">
        <strong>{t(`capacity_${measure}`)}</strong>
        {value.limit === null ? (
          <span className="muted">{t('capacityNoLimit', { used: value.used, unit })}</span>
        ) : (
          <span>
            <bdi dir="ltr">
              {value.used} / {value.limit} {unit}
            </bdi>{' '}
            <span className="muted">
              ({value.fillPercent}%) ·{' '}
              {t('capacityRemaining', { remaining: value.remaining ?? '', unit })}
            </span>
          </span>
        )}
      </div>
      {value.limit !== null && value.fillPercent !== null && (
        <div
          className="capacity-bar"
          role="meter"
          aria-label={t(`capacity_${measure}`)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(Number(value.fillPercent), 100)}
        >
          <span style={{ inlineSize: `${Math.min(Number(value.fillPercent), 100)}%` }} />
        </div>
      )}
      {!value.complete && <p className="muted">{t('capacityNotChecked')}</p>}
    </div>
  );
}

/** The list's fill column: the higher of CBM and weight, grey "incomplete" when unmeasured. */
export function FillCell({
  fillPercent,
  fillIncomplete,
}: {
  fillPercent: DecimalString | null;
  fillIncomplete: boolean;
}) {
  const t = useTranslations('Consolidations');
  if (fillPercent === null) return <span className="muted">—</span>;
  return (
    <span className={`capacity-fill capacity-${level(fillPercent)}`}>
      <bdi dir="ltr">{fillPercent}%</bdi>
      {fillIncomplete && <span className="muted"> · {t('capacityIncompleteShort')}</span>}
    </span>
  );
}

/** The picker's estimate for one shipment (adding decides). */
export function FitNote({ fit }: { fit: ContainerFitDto | undefined }) {
  const t = useTranslations('Consolidations');
  const names = useMeasureNames();
  if (!fit) return null;
  if (!fit.fits) {
    return <span className="capacity-full">{t('fitOver', { measures: names(fit.over) })}</span>;
  }
  const left = [
    fit.remainingVolumeCbm !== null && `${fit.remainingVolumeCbm} ${t('unit_volumeCbm')}`,
    fit.remainingWeightKg !== null && `${fit.remainingWeightKg} ${t('unit_weightKg')}`,
  ].filter(Boolean);
  return (
    <span className="muted">
      {left.length > 0 ? t('fitLeft', { left: left.join(' · ') }) : t('fitNoLimit')}
      {fit.unchecked.length > 0 && ` · ${t('fitUnchecked', { measures: names(fit.unchecked) })}`}
    </span>
  );
}
