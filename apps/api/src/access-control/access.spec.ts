import { ROLE_PERMISSIONS, type Permission } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { type AccessRows, computeAccess, explainAccess } from './access.js';

// effective(u, b) of plan 03, section 4, one rule at a time.

const DXB = 'dxb';
const JED = 'jed';
const SALES_TEAM = 'team-sales';
const DRIVER_TEAM = 'team-driver';
const CUSTOM_TEAM = 'team-custom';

function rows(over: Partial<AccessRows> = {}): AccessRows {
  return {
    version: '7',
    roles: ['SALES'],
    branchIds: [DXB, JED],
    teams: [
      { id: SALES_TEAM, systemRole: 'SALES', restricted: false, isActive: true, changes: [] },
      { id: DRIVER_TEAM, systemRole: 'DRIVER', restricted: true, isActive: true, changes: [] },
      {
        id: CUSTOM_TEAM,
        systemRole: null,
        restricted: false,
        isActive: true,
        changes: [{ permission: 'manual_journals:view', effect: 'ALLOW' }],
      },
    ],
    branchTeams: [],
    branchPermissions: [],
    blocked: [],
    delegations: [],
    ...over,
  };
}

const allow = (branchId: string, permission: Permission, delegationId: string | null = null) => ({
  branchId,
  permission,
  effect: 'ALLOW' as const,
  delegationId,
});

describe('who may do what, per branch', () => {
  it('gives every person their role defaults in each branch, at the loaded version', () => {
    const access = computeAccess(rows());
    expect(access.version).toBe('7');
    for (const b of [DXB, JED])
      expect(access.inBranch(b)).toEqual([...ROLE_PERMISSIONS.SALES].sort());
    expect(access.has('bookings:create', DXB)).toBe(true);
    expect(access.has('bookings:create', 'krt')).toBe(false);
    expect(access.has('bookings:create', null)).toBe(false);
  });

  it('applies a change to a system team in every branch', () => {
    const access = computeAccess(
      rows({
        teams: [
          {
            id: SALES_TEAM,
            systemRole: 'SALES',
            restricted: false,
            isActive: true,
            changes: [
              { permission: 'bookings:create', effect: 'DENY' },
              { permission: 'manual_journals:view', effect: 'ALLOW' },
            ],
          },
        ],
      }),
    );
    expect(access.any('bookings:create')).toBe(false);
    expect(access.has('manual_journals:view', JED)).toBe(true);
  });

  it('gives a team or a permission given in one branch in that branch only', () => {
    const access = computeAccess(
      rows({
        branchTeams: [{ teamId: CUSTOM_TEAM, branchId: DXB, delegationId: null }],
        branchPermissions: [allow(DXB, 'expenses:create')],
      }),
    );
    expect(access.has('manual_journals:view', DXB)).toBe(true);
    expect(access.has('manual_journals:view', JED)).toBe(false);
    expect(access.has('expenses:create', DXB)).toBe(true);
    expect(access.has('expenses:create', JED)).toBe(false);
    expect(access.branchesWith(['manual_journals:view', 'expenses:create'])).toEqual([DXB]);
  });

  it('lets an inactive new team give nothing', () => {
    const access = computeAccess(
      rows({
        teams: [
          { id: SALES_TEAM, systemRole: 'SALES', restricted: false, isActive: true, changes: [] },
          {
            id: CUSTOM_TEAM,
            systemRole: null,
            restricted: false,
            isActive: false,
            changes: [{ permission: 'manual_journals:view', effect: 'ALLOW' }],
          },
        ],
        branchTeams: [{ teamId: CUSTOM_TEAM, branchId: DXB, delegationId: null }],
      }),
    );
    expect(access.any('manual_journals:view')).toBe(false);
  });

  it('lets an owner DENY win over every grant, in its branch only', () => {
    const access = computeAccess(
      rows({
        branchTeams: [{ teamId: CUSTOM_TEAM, branchId: DXB, delegationId: null }],
        branchPermissions: [
          { branchId: DXB, permission: 'manual_journals:view', effect: 'DENY', delegationId: null },
          { branchId: DXB, permission: 'bookings:create', effect: 'DENY', delegationId: null },
        ],
      }),
    );
    expect(access.has('manual_journals:view', DXB)).toBe(false);
    expect(access.has('bookings:create', DXB)).toBe(false);
    expect(access.has('bookings:create', JED)).toBe(true);
  });

  it('ignores a DENY that came through a delegation (owner-only, also a CHECK)', () => {
    const access = computeAccess(
      rows({
        branchPermissions: [
          { branchId: DXB, permission: 'bookings:create', effect: 'DENY', delegationId: 'd' },
        ],
      }),
    );
    expect(access.has('bookings:create', DXB)).toBe(true);
  });

  it('takes a blocked permission away from everyone in that branch, Management included', () => {
    const blocked = [{ branchId: JED, permission: 'bookings:create' }];
    expect(computeAccess(rows({ blocked })).has('bookings:create', JED)).toBe(false);
    expect(computeAccess(rows({ blocked })).has('bookings:create', DXB)).toBe(true);
    const management = computeAccess(
      rows({
        roles: ['MANAGEMENT'],
        teams: [
          {
            id: 'm',
            systemRole: 'MANAGEMENT',
            restricted: false,
            isActive: true,
            changes: [],
          },
        ],
        blocked: [{ branchId: JED, permission: 'bookings:view' }],
      }),
    );
    expect(management.has('bookings:view', JED)).toBe(false);
    expect(management.has('bookings:view', DXB)).toBe(true);
  });

  it('leaves the Administrator untouched by changes, blocks and denials', () => {
    const access = computeAccess(
      rows({
        roles: ['ADMINISTRATOR'],
        blocked: [{ branchId: JED, permission: 'users:update' }],
        branchPermissions: [
          { branchId: DXB, permission: 'users:update', effect: 'DENY', delegationId: null },
        ],
      }),
    );
    for (const b of [DXB, JED]) {
      expect(access.inBranch(b)).toEqual([...ROLE_PERMISSIONS.ADMINISTRATOR].sort());
    }
  });

  it('never gives a non-grantable permission (user management) to anyone else', () => {
    const access = computeAccess(
      rows({
        branchPermissions: [allow(DXB, 'users:update')],
        teams: [
          {
            id: SALES_TEAM,
            systemRole: 'SALES',
            restricted: false,
            isActive: true,
            changes: [{ permission: 'users:view', effect: 'ALLOW' }],
          },
        ],
      }),
    );
    expect(access.any('users:update')).toBe(false);
    expect(access.any('users:view')).toBe(false);
  });

  it('gives a holder of a restricted role (driver) nothing beyond that role', () => {
    const access = computeAccess(
      rows({
        roles: ['DRIVER'],
        branchTeams: [{ teamId: CUSTOM_TEAM, branchId: DXB, delegationId: null }],
        branchPermissions: [allow(DXB, 'expenses:create')],
        teams: [
          {
            id: DRIVER_TEAM,
            systemRole: 'DRIVER',
            restricted: true,
            isActive: true,
            changes: [{ permission: 'manual_journals:view', effect: 'ALLOW' }],
          },
          {
            id: CUSTOM_TEAM,
            systemRole: null,
            restricted: false,
            isActive: true,
            changes: [{ permission: 'bookings:view', effect: 'ALLOW' }],
          },
        ],
      }),
    );
    expect(access.inBranch(DXB)).toEqual([...ROLE_PERMISSIONS.DRIVER].sort());
  });

  describe('a delegation', () => {
    const delegated = (
      live: boolean,
      branchId = DXB,
      permissions: string[] = ['manual_journals:view'],
    ) =>
      rows({
        branchTeams: [{ teamId: CUSTOM_TEAM, branchId: DXB, delegationId: 'd' }],
        branchPermissions: [
          allow(DXB, 'expenses:create', 'd'),
          allow(DXB, 'manual_journals:create', 'd'),
        ],
        delegations: [
          { id: 'd', branchId, live, permissions: [...permissions, 'expenses:create'] },
        ],
      });

    it('gives only what its ceiling holds, in its branch', () => {
      const access = computeAccess(delegated(true));
      expect(access.has('manual_journals:view', DXB)).toBe(true);
      expect(access.has('expenses:create', DXB)).toBe(true);
      // Given through the delegation, but above its ceiling.
      expect(access.has('manual_journals:create', DXB)).toBe(false);
      expect(access.has('manual_journals:view', JED)).toBe(false);
    });

    it('stops counting once revoked or its delegate left', () => {
      const access = computeAccess(delegated(false));
      expect(access.has('manual_journals:view', DXB)).toBe(false);
      expect(access.has('expenses:create', DXB)).toBe(false);
    });

    it('counts nowhere when its rows name another branch than its own', () => {
      const access = computeAccess(delegated(true, JED));
      expect(access.has('manual_journals:view', DXB)).toBe(false);
      expect(access.has('expenses:create', DXB)).toBe(false);
    });

    it('cannot give past the ceiling a team member of the delegate would get', () => {
      const access = computeAccess(delegated(true, DXB, []));
      expect(access.has('manual_journals:view', DXB)).toBe(false);
    });
  });

  it('holds a global module (master data) wherever it is held', () => {
    const access = computeAccess(rows({ branchPermissions: [allow(DXB, 'master_data:update')] }));
    expect(access.has('master_data:update', JED)).toBe(true);
    expect(access.has('master_data:update', null)).toBe(true);
  });
});

describe('why a permission is held', () => {
  it('names the role team, the branch team, the added permission and the delegation', () => {
    const explained = explainAccess(
      rows({
        branchTeams: [{ teamId: CUSTOM_TEAM, branchId: DXB, delegationId: null }],
        branchPermissions: [
          allow(DXB, 'expenses:create'),
          allow(DXB, 'manual_journals:create', 'd'),
        ],
        delegations: [
          { id: 'd', branchId: DXB, live: true, permissions: ['manual_journals:create'] },
        ],
      }),
      DXB,
    );
    const of = (p: Permission) => explained.find((e) => e.permission === p)?.sources;
    expect(of('bookings:create')).toEqual([{ kind: 'ROLE', teamId: SALES_TEAM }]);
    expect(of('manual_journals:view')).toEqual([{ kind: 'TEAM', teamId: CUSTOM_TEAM }]);
    expect(of('expenses:create')).toEqual([{ kind: 'ADDED' }]);
    expect(of('manual_journals:create')).toEqual([{ kind: 'DELEGATED', delegationId: 'd' }]);
    expect(explained.every((e) => e.sources.length > 0)).toBe(true);
  });
});
