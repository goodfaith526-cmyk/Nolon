import { describe, expect, it } from 'vitest';
import { followLoadType } from './load-type.js';

describe('followLoadType (functional review B2)', () => {
  it('keeps a load type that is given, null and LCL for a container included', () => {
    expect(followLoadType('LCL', { mode: 'SEA', cargoType: 'CONTAINER' })).toBe('LCL');
    expect(followLoadType(null, { mode: 'SEA', cargoType: 'CONTAINER' })).toBeNull();
  });

  it('follows the cargo type when left out, on a sea leg only', () => {
    expect(followLoadType(undefined, { mode: 'SEA', cargoType: 'CONTAINER' })).toBe('FCL');
    expect(followLoadType(undefined, { mode: 'SEA_ROAD', cargoType: 'PALLET' })).toBe('LCL');
    expect(followLoadType(undefined, { mode: 'ROAD', cargoType: 'CONTAINER' })).toBeNull();
  });

  it('on an edit, follows only if the saved one did', () => {
    const followed = { mode: 'SEA', cargoType: 'CONTAINER', loadType: 'FCL' } as const;
    expect(followLoadType(undefined, { mode: 'SEA', cargoType: 'PALLET' }, followed)).toBe('LCL');
    const chosen = { mode: 'SEA', cargoType: 'CONTAINER', loadType: 'LCL' } as const;
    expect(followLoadType(undefined, { mode: 'SEA', cargoType: 'CONTAINER' }, chosen)).toBe('LCL');
    const unset = { mode: 'SEA', cargoType: 'CONTAINER', loadType: null } as const;
    expect(followLoadType(undefined, { mode: 'SEA', cargoType: 'CONTAINER' }, unset)).toBeNull();
    const road = { mode: 'ROAD', cargoType: 'CONTAINER', loadType: null } as const;
    expect(followLoadType(undefined, { mode: 'SEA', cargoType: 'CONTAINER' }, road)).toBe('FCL');
  });

  it('drops a chosen load type when the sea leg goes', () => {
    const chosen = { mode: 'SEA', cargoType: 'CONTAINER', loadType: 'LCL' } as const;
    expect(followLoadType(undefined, { mode: 'ROAD', cargoType: 'CONTAINER' }, chosen)).toBeNull();
  });
});
