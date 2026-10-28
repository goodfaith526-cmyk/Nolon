import type { Permission } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import {
  accessErrorKey,
  accessLevel,
  moduleActions,
  moduleDiffers,
  removedPermissions,
  samePermissions,
  togglePermission,
} from './access';
import { ApiError } from './api';

describe('accessLevel (annex letters)', () => {
  it('reads the five annex levels from the actions a team holds', () => {
    const full: Permission[] = [
      'customers:view',
      'customers:create',
      'customers:update',
      'customers:approve',
      'customers:cancel',
    ];
    expect(accessLevel(full, 'customers')).toBe('F');
    expect(accessLevel(['quotations:approve', 'quotations:view'], 'quotations')).toBe('A');
    expect(accessLevel(['bookings:view', 'bookings:update', 'bookings:create'], 'bookings')).toBe(
      'E',
    );
    expect(accessLevel(['rates:view'], 'rates')).toBe('V');
    expect(accessLevel(['rates:view'], 'customers')).toBe('N');
  });

  it('marks a set of actions the annex has no letter for', () => {
    expect(accessLevel(['customers:view', 'customers:cancel'], 'customers')).toBe('C');
    expect(accessLevel(['customers:create'], 'customers')).toBe('C');
  });

  it('only looks at the module asked for', () => {
    expect(accessLevel(['customers:view', 'rates:approve'], 'customers')).toBe('V');
  });
});

describe('team helpers', () => {
  it('lists a module’s actions in the fixed order', () => {
    expect(moduleActions(['pod:cancel', 'pod:view', 'rates:view'], 'pod')).toEqual([
      'view',
      'cancel',
    ]);
  });

  it('tells a changed cell from a default one', () => {
    const defaults: Permission[] = ['customers:view', 'rates:view'];
    const now: Permission[] = ['rates:view', 'customers:view', 'customers:create'];
    expect(moduleDiffers(now, defaults, 'customers')).toBe(true);
    expect(moduleDiffers(now, defaults, 'rates')).toBe(false);
    expect(samePermissions(['rates:view', 'customers:view'], defaults)).toBe(true);
    expect(samePermissions(now, defaults)).toBe(false);
  });

  it('toggles a permission and keeps the set sorted', () => {
    expect(togglePermission(['rates:view'], 'customers:view', true)).toEqual([
      'customers:view',
      'rates:view',
    ]);
    expect(togglePermission(['rates:view'], 'rates:view', false)).toEqual([]);
  });

  it('finds what a smaller ceiling loses', () => {
    expect(removedPermissions(['rates:view', 'customers:view'], ['rates:view'])).toEqual([
      'customers:view',
    ]);
    expect(removedPermissions(['rates:view'], ['rates:view', 'customers:view'])).toEqual([]);
  });
});

describe('accessErrorKey', () => {
  it('maps the API answers', () => {
    expect(accessErrorKey(new ApiError(409, 'Permissions changed, reload'))).toBe('stale');
    expect(accessErrorKey(new ApiError(409, 'Team code already in use'))).toBe('conflict');
    expect(accessErrorKey(new ApiError(403, 'Forbidden'))).toBe('noAccess');
    expect(accessErrorKey(new ApiError(400, 'Bad Request'))).toBe('invalid');
    expect(accessErrorKey(new Error('network'))).toBe('failed');
  });
});
