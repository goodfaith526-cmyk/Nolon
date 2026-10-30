import { describe, expect, it } from 'vitest';
import {
  OUTLET_SCOPED,
  PERMISSION_MATRIX,
  PERMISSION_MODULES,
  ROLE_PERMISSIONS,
  ROLES,
  hasAllBranchAccess,
  isRole,
  permissionsForRoles,
  type Permission,
  type PermissionModule,
  type Role,
} from './auth.js';
import { seesCustomsCosts } from './customs.js';

const ACTIONS_BY_LEVEL = {
  F: ['view', 'create', 'update', 'approve', 'cancel'],
  A: ['view', 'approve'],
  E: ['view', 'create', 'update'],
  V: ['view'],
  N: [],
} as const;

function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

describe('permission matrix (annex A)', () => {
  it('has one cell per role for every module, each a known level', () => {
    for (const module of PERMISSION_MODULES) {
      expect(PERMISSION_MATRIX[module]).toMatch(/^[FAEVN]{11}$/);
    }
    expect(ROLES).toHaveLength(11);
  });

  it('expands every cell to exactly the actions of its level', () => {
    for (const module of PERMISSION_MODULES) {
      ROLES.forEach((role, i) => {
        const level = PERMISSION_MATRIX[module][i] as keyof typeof ACTIONS_BY_LEVEL;
        const granted = [...ROLE_PERMISSIONS[role]]
          .filter((p) => p.startsWith(`${module}:`))
          .map((p) => p.slice(module.length + 1))
          .sort();
        expect(granted, `${module}/${role}`).toEqual([...ACTIONS_BY_LEVEL[level]].sort());
      });
    }
  });

  // Spot checks against the annex table, row by row in its own words.
  const rows: [PermissionModule, string][] = [
    ['customer_profiles', '— — — — — — — — — — —'],
    ['customer_profile_intake', '— — — — — — — — — — —'],
    ['customer_profile_followup', '— — — — — — — — — — —'],
    ['customers', 'ك ع ك ك ع ع ع ع — ك إ'],
    // Changed after the annex (owner, 2026-10-19): rate cards belong to the Sales & Marketing
    // Manager, the tenth column (Sales' cells elsewhere). The eleventh column is Outlet Staff
    // (business model plan 4.2, owner 2026-10-21).
    ['rates', 'ك ع ع ع ع ع — — — ك ع'],
    // Business model plan 4.1: reference costs and the expected margin, apart from the rates so
    // Sales and Operations see a price without its cost.
    ['rate_costs', 'ك ع ع — — ع — — — ك —'],
    ['quotations', 'ك ع م ك ع ع — — — ك إ'],
    ['bookings', 'ك ع م ك ك ع ع ع — ك إ'],
    ['shipments', 'ك ع ك ع ك ع ع ع ع ع ع'],
    ['consolidation', 'ك ع ك — ك ع ع — — — —'],
    // Added after the annex (owner, 2026-10-14): booking into an open container.
    ['container_booking', 'ك — — إ إ — — — — إ —'],
    ['warehouse', 'ك ع ك ع ع ع ك ع — ع —'],
    ['customs', 'ك ع ك ع ع ع — ك — ع —'],
    ['transport_fleet', 'ك ع ك — ك ع — — — — —'],
    ['transport_trips', 'ك ع ك ع ك ع ع — إ ع —'],
    ['pod', 'ك ع ك ع ك ع ك — إ ع —'],
    ['documents', 'ك ع ك إ إ إ إ إ إ إ إ'],
    ['customer_invoices', 'ك ع م ع ع ك — — — ع —'],
    ['credit_notes', 'ك ع م — — إ — — — — —'],
    ['receipts', 'ك ع ع ع — ك — — — ع —'],
    ['suppliers', 'ك ع م — إ ك — — — — —'],
    // Business model plan 4.1 (owner, 2026-10-21): partners of the network.
    ['partners', 'ك ع ك ع ع ع — — — ك ع'],
    ['partner_contracts', 'ك ع ع — — ع — — — ك —'],
    // Plan 07 section 8: create = a statement, update = cancelling a draft one, approve = a manual
    // adjustment. Finance makes statements, the Branch Manager adjusts.
    ['partner_commissions', 'ك ع م — — إ — — — ع —'],
    ['supplier_payments', 'ك ع م — — ك — — — — —'],
    ['expenses', 'ك ع م — إ ك إ إ إ — —'],
    ['manual_journals', 'ك ع — — — ك — — — — —'],
    ['chart_of_accounts', 'ك ع — — — م — — — — —'],
    ['fx_rates', 'ك ع — — — ك — — — — —'],
    ['shipment_profitability', 'ك ع ع — — ع — — — — —'],
    ['financial_reports', 'ك ع ع — — ع — — — — —'],
    ['operational_reports', 'ك ع ع ع ع ع ع ع — ع —'],
    ['dashboards', 'ك ع ع ع ع ع — — — ع —'],
    ['alert_settings', 'ك — — — — — — — — — —'],
    ['master_data', 'ك ع ع ع ع ع ع ع ع ع ع'],
    ['users', 'ك — — — — — — — — — —'],
    ['audit_log', 'ع ع ع — — — — — — — —'],
    // Plan 03 (owner, 2026-10-27): the permissions screen, the Administrator only.
    ['access_control', 'ك — — — — — — — — — —'],
    // Plan 04a section 2 (2026-10-28): staff review of the shipping bot's requests.
    ['cs_booking_requests', 'ك ع ك ك ع — — — — ك —'],
    // Plan 04 section 4.1 (2026-10-28): payment instructions, two people per approval.
    ['payment_instructions', 'ك م ك ع — إ — — — — —'],
  ];
  const arabicToLevel: Record<string, string> = { ك: 'F', م: 'A', إ: 'E', ع: 'V', '—': 'N' };

  it('matches the annex row for every module', () => {
    expect(rows.map(([m]) => m).sort()).toEqual([...PERMISSION_MODULES].sort());
    for (const [module, annexRow] of rows) {
      const levels = annexRow
        .split(' ')
        .map((cell) => arabicToLevel[cell])
        .join('');
      expect(PERMISSION_MATRIX[module], module).toBe(levels);
    }
  });

  it('keeps the key negative cases', () => {
    expect(can('SALES', 'customer_invoices:create')).toBe(false);
    expect(can('DRIVER', 'customer_invoices:view')).toBe(false);
    expect(can('DRIVER', 'shipment_profitability:view')).toBe(false);
    expect(can('BRANCH_MANAGER', 'manual_journals:view')).toBe(false);
    expect(can('MANAGEMENT', 'customers:create')).toBe(false);
    expect(can('ADMINISTRATOR', 'audit_log:update')).toBe(false);
    expect(can('FINANCE', 'chart_of_accounts:create')).toBe(false);
    expect(can('FINANCE', 'chart_of_accounts:approve')).toBe(true);
    expect(can('SALES', 'rates:approve')).toBe(false);
    expect(can('SALES', 'rates:create')).toBe(false);
    expect(can('SALES', 'rates:update')).toBe(false);
    expect(can('BRANCH_MANAGER', 'rates:approve')).toBe(false);
    expect(can('SALES_MARKETING_MANAGER', 'rates:create')).toBe(true);
    expect(can('SALES_MARKETING_MANAGER', 'rates:update')).toBe(true);
    expect(can('SALES_MARKETING_MANAGER', 'rates:approve')).toBe(true);
    expect(can('SALES_MARKETING_MANAGER', 'rates:cancel')).toBe(true);
    expect(can('SALES_MARKETING_MANAGER', 'customer_invoices:create')).toBe(false);
    // Sales book into open containers, and nothing more about containers.
    expect(can('SALES', 'container_booking:create')).toBe(true);
    expect(can('SALES', 'consolidation:view')).toBe(false);
    expect(can('SALES', 'consolidation:update')).toBe(false);
    expect(can('BRANCH_MANAGER', 'container_booking:create')).toBe(false);
    // Outlet staff (plan 4.2): no approving, no money, no costs, no reports, no administration.
    expect(can('OUTLET_STAFF', 'quotations:approve')).toBe(false);
    expect(can('OUTLET_STAFF', 'bookings:approve')).toBe(false);
    expect(can('OUTLET_STAFF', 'shipments:update')).toBe(false);
    expect(can('OUTLET_STAFF', 'rates:create')).toBe(false);
    expect(can('OUTLET_STAFF', 'partners:update')).toBe(false);
    expect(can('OUTLET_STAFF', 'customer_invoices:view')).toBe(false);
    expect(can('OUTLET_STAFF', 'shipment_profitability:view')).toBe(false);
    expect(can('OUTLET_STAFF', 'operational_reports:view')).toBe(false);
    expect(can('OUTLET_STAFF', 'users:view')).toBe(false);
  });

  it('gives Outlet Staff only outlet-scoped modules, rates and master data', () => {
    const modules = new Set(
      [...ROLE_PERMISSIONS.OUTLET_STAFF].map((p) => p.slice(0, p.indexOf(':'))),
    );
    for (const module of modules) {
      expect([...OUTLET_SCOPED, 'rates', 'master_data'], module).toContain(module);
    }
    expect(hasAllBranchAccess(['OUTLET_STAFF'])).toBe(false);
  });
});

describe('customs costs (group Z2)', () => {
  it('only roles that see shipment profitability see supplier costs on the customs file', () => {
    const sees = (role: Role) => seesCustomsCosts((p) => can(role, p));
    expect(ROLES.filter(sees)).toEqual(ROLES.filter((r) => can(r, 'shipment_profitability:view')));
    expect(sees('CUSTOMS')).toBe(false);
    expect(sees('SALES')).toBe(false);
    expect(sees('FINANCE')).toBe(true);
  });
});

describe('permissionsForRoles', () => {
  it('adds up permissions across roles', () => {
    const perms = permissionsForRoles(['SALES', 'FINANCE']);
    expect(perms).toContain('quotations:create');
    expect(perms).toContain('customer_invoices:approve');
    expect(perms).not.toContain('users:view');
  });

  it('returns nothing for no roles', () => {
    expect(permissionsForRoles([])).toEqual([]);
  });
});

describe('branch scope by role', () => {
  it('gives every branch only to Administrator and Management', () => {
    expect(hasAllBranchAccess(['ADMINISTRATOR'])).toBe(true);
    expect(hasAllBranchAccess(['SALES', 'MANAGEMENT'])).toBe(true);
    expect(hasAllBranchAccess(['BRANCH_MANAGER'])).toBe(false);
    expect(hasAllBranchAccess([])).toBe(false);
  });

  it('recognizes role names', () => {
    expect(isRole('FINANCE')).toBe(true);
    expect(isRole('finance')).toBe(false);
  });
});
