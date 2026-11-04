import { describe, expect, it } from 'vitest';
import { CS_PRICING_MODES, RATE_UNITS, pricingModeOf } from './index.js';

describe('pricingModeOf (what a customer-service bot must collect for a category)', () => {
  it('counts barrels, pieces, pallets and containers; measures CBM; weighs kilos; flat per shipment', () => {
    expect(pricingModeOf('PER_BARREL')).toBe('counted');
    expect(pricingModeOf('PER_PIECE')).toBe('counted');
    expect(pricingModeOf('PER_PALLET')).toBe('counted');
    expect(pricingModeOf('PER_CONTAINER')).toBe('counted');
    expect(pricingModeOf('PER_CBM')).toBe('volume');
    expect(pricingModeOf('PER_KG')).toBe('weight');
    expect(pricingModeOf('PER_SHIPMENT')).toBe('flat');
  });

  it('gives every rate unit a mode', () => {
    for (const unit of RATE_UNITS) expect(CS_PRICING_MODES).toContain(pricingModeOf(unit));
  });
});
