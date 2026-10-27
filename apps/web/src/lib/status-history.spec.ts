import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { earliestLocalMinute, needsFreshShipment } from './status-history';

describe('earliestLocalMinute', () => {
  it('rounds a floor with seconds up to the next minute the API accepts', () => {
    const floor = '2026-10-27T10:02:45.123Z';
    const min = earliestLocalMinute(floor);
    // The input's minimum, read back as the time it would send, is not before the API's floor.
    expect(Date.parse(new Date(min).toISOString())).toBeGreaterThanOrEqual(Date.parse(floor));
    expect(Date.parse(new Date(min).toISOString()) - Date.parse(floor)).toBeLessThan(60_000);
    expect(new Date(min).getSeconds()).toBe(0);
  });

  it('keeps a floor that is already a whole minute', () => {
    const floor = '2026-10-27T10:02:00.000Z';
    expect(new Date(earliestLocalMinute(floor)).toISOString()).toBe(floor);
  });
});

describe('needsFreshShipment', () => {
  it('reloads after a stale revert or a container closed meanwhile, nothing else', () => {
    const refusal = (status: number, code: string | null) =>
      new ApiError(status, 'x', [], null, code);
    expect(needsFreshShipment(refusal(409, 'REVERT_STALE'))).toBe(true);
    expect(needsFreshShipment(refusal(409, 'REVERT_CLOSED_CONTAINER'))).toBe(true);
    expect(needsFreshShipment(refusal(409, null))).toBe(false);
    expect(needsFreshShipment(refusal(400, 'STATUS_TIME_TOO_EARLY'))).toBe(false);
    expect(needsFreshShipment(new Error('x'))).toBe(false);
  });
});
