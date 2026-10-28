import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  type CargoShipment,
  type ContainerLimits,
  containerLoad,
  dimensionDto,
  fillOf,
  missingMeasures,
  overLimits,
  unmeasured,
} from './container-capacity.js';

const line = (volumeCbm: string | null, weightKg: string | null) => ({
  volumeCbm: volumeCbm === null ? null : dec(volumeCbm),
  weightKg: weightKg === null ? null : dec(weightKg),
});
const shipment = (id: string, ...items: ReturnType<typeof line>[]): CargoShipment => ({
  id,
  items,
});
const limits = (volumeCbm: string | null, weightKg: string | null): ContainerLimits => ({
  volumeCbm: volumeCbm === null ? null : dec(volumeCbm),
  weightKg: weightKg === null ? null : dec(weightKg),
});

describe('container capacity', () => {
  it('sums the known measures and lists the shipments missing one, never as zero', () => {
    const load = containerLoad([
      shipment('a', line('1.5', '100'), line('2', null)),
      shipment('b', line(null, '50')),
      shipment('c'),
    ]);
    expect(load.volumeCbm.used.toFixed()).toBe('3.5');
    expect(load.weightKg.used.toFixed()).toBe('150');
    expect(load.volumeCbm.pending).toEqual(['b', 'c']);
    expect(load.weightKg.pending).toEqual(['a', 'c']);
    expect(missingMeasures(shipment('c'))).toEqual(['volumeCbm', 'weightKg']);
    expect(missingMeasures(shipment('d', line('1', '1')))).toEqual([]);
  });

  it('refuses only a write that ends over a limit and adds to the load', () => {
    const limit = limits('10', null);
    const at = (cbm: string) => containerLoad([shipment('a', line(cbm, '1'))]);
    expect(overLimits(limit, at('6'), at('10'))).toEqual([]);
    expect(overLimits(limit, at('6'), at('10.0001'))).toEqual(['volumeCbm']);
    // Over already (a lowered limit): what does not add is accepted.
    expect(overLimits(limit, at('12'), at('12'))).toEqual([]);
    expect(overLimits(limit, at('12'), at('12.5'))).toEqual(['volumeCbm']);
    // No limit on weight: never over on it.
    expect(overLimits(limits(null, null), at('1'), at('1000'))).toEqual([]);
  });

  it('names the limited measures missing for closing or loading', () => {
    const load = containerLoad([shipment('a', line(null, null))]);
    expect(unmeasured(limits('10', null), load)).toEqual([
      { measure: 'volumeCbm', shipmentIds: ['a'] },
    ]);
    expect(unmeasured(limits(null, null), load)).toEqual([]);
  });

  it('gives the fill of the fuller limited measure, one decimal, and none without limits', () => {
    const load = containerLoad([shipment('a', line('2', '900')), shipment('b', line(null, '1'))]);
    expect(fillOf(limits('3', '1000'), load)).toEqual({
      fillPercent: '90.1',
      fillIncomplete: true,
    });
    expect(fillOf(limits('3', null), load)).toEqual({ fillPercent: '66.7', fillIncomplete: true });
    expect(fillOf(limits(null, null), load)).toEqual({ fillPercent: null, fillIncomplete: false });
    expect(dimensionDto(dec('1.5'), load.volumeCbm)).toEqual({
      limit: '1.5',
      used: '2',
      remaining: '-0.5',
      fillPercent: '133.3',
      complete: false,
    });
    expect(dimensionDto(null, load.weightKg)).toEqual({
      limit: null,
      used: '901',
      remaining: null,
      fillPercent: null,
      complete: true,
    });
  });
});
