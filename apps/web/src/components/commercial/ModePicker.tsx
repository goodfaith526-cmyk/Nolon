'use client';

import { hasRoadLeg, hasSeaLeg, modeOfLegs, type ShippingMode } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/**
 * Shipping mode as two ticks, sea and road (owner, 2026-10-19): one or both. Both is SEA_ROAD.
 * At least one stays ticked.
 */
export function ModePicker({
  label,
  value,
  onChange,
  disabled = false,
  invalid,
  note,
}: {
  label: string;
  value: ShippingMode;
  onChange: (mode: ShippingMode) => void;
  disabled?: boolean;
  invalid?: { 'data-invalid'?: true };
  note?: ReactNode;
}) {
  const te = useTranslations('Enums');
  const sea = hasSeaLeg(value);
  const road = hasRoadLeg(value);
  const tick = (nextSea: boolean, nextRoad: boolean) => {
    const next = modeOfLegs(nextSea, nextRoad);
    if (next) onChange(next);
  };
  return (
    <fieldset className="field bare" {...invalid}>
      <legend>{label}</legend>
      <span className="checks">
        <label>
          <input
            type="checkbox"
            checked={sea}
            disabled={disabled || (sea && !road)}
            onChange={(e) => tick(e.target.checked, road)}
          />{' '}
          {te('mode_SEA')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={road}
            disabled={disabled || (road && !sea)}
            onChange={(e) => tick(sea, e.target.checked)}
          />{' '}
          {te('mode_ROAD')}
        </label>
      </span>
      {note}
    </fieldset>
  );
}
