/**
 * Roles and permissions, transcribed from annex A (02a-annex-permissions.md). Roles are fixed:
 * there is no role editor, and changing this table after sign-off is a change request.
 */

export const ROLES = [
  'ADMINISTRATOR',
  'MANAGEMENT',
  'BRANCH_MANAGER',
  'SALES',
  'OPERATIONS',
  'FINANCE',
  'WAREHOUSE',
  'CUSTOMS',
  'DRIVER',
] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Roles that see every branch through the role itself (annex A, branch scope). */
export const ALL_BRANCH_ROLES: readonly Role[] = ['ADMINISTRATOR', 'MANAGEMENT'];

export const PERMISSION_ACTIONS = ['view', 'create', 'update', 'approve', 'cancel'] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_MODULES = [
  'customers',
  'rates',
  'quotations',
  'bookings',
  'shipments',
  'consolidation',
  'warehouse',
  'customs',
  'transport_fleet',
  'transport_trips',
  'pod',
  'documents',
  'customer_invoices',
  'credit_notes',
  'receipts',
  'suppliers',
  'supplier_payments',
  'expenses',
  'manual_journals',
  'chart_of_accounts',
  'fx_rates',
  'shipment_profitability',
  'financial_reports',
  'operational_reports',
  'dashboards',
  'alert_settings',
  'master_data',
  'users',
  'audit_log',
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];

/** A permission is `module:action`, e.g. `customers:create`. */
export type Permission = `${PermissionModule}:${PermissionAction}`;

/**
 * Access levels, as in annex A:
 * F (ك) full: view, create, update, approve, cancel
 * A (م) view and approve
 * E (إ) view, create and update before approval
 * V (ع) view only
 * N (—) no access
 */
type Level = 'F' | 'A' | 'E' | 'V' | 'N';

const LEVEL_ACTIONS: Record<Level, readonly PermissionAction[]> = {
  F: ['view', 'create', 'update', 'approve', 'cancel'],
  A: ['view', 'approve'],
  E: ['view', 'create', 'update'],
  V: ['view'],
  N: [],
};

/**
 * One string per module, one letter per role in ROLES order:
 * Admin, Management, Branch Mgr, Sales, Operations, Finance, Warehouse, Customs, Driver.
 * "(own branch)" and "(own trips)" cells are view/edit here; branch scoping and the Driver's
 * own-trips filter (DRIVER_OWN_TRIPS_ONLY) narrow the rows.
 */
export const PERMISSION_MATRIX: Record<PermissionModule, string> = {
  customers: 'FVFFVVVVN',
  rates: 'FVAEVVNNN',
  quotations: 'FVAFVVNNN',
  bookings: 'FVAFFVVVN',
  shipments: 'FVFVFVVVV',
  consolidation: 'FVFNFVVNN',
  warehouse: 'FVFVVVFVN',
  customs: 'FVFVVVNFN',
  transport_fleet: 'FVFNFVNNN',
  transport_trips: 'FVFVFVVNE',
  pod: 'FVFVFVFNE',
  documents: 'FVFEEEEEE',
  customer_invoices: 'FVAVVFNNN',
  credit_notes: 'FVANNENNN',
  receipts: 'FVVVNFNNN',
  suppliers: 'FVANEFNNN',
  supplier_payments: 'FVANNFNNN',
  expenses: 'FVANEFEEE',
  manual_journals: 'FVNNNFNNN',
  chart_of_accounts: 'FVNNNANNN',
  fx_rates: 'FVNNNFNNN',
  shipment_profitability: 'FVVNNVNNN',
  financial_reports: 'FVVNNVNNN',
  operational_reports: 'FVVVVVVVN',
  dashboards: 'FVVVVVNNN',
  alert_settings: 'FNNNNNNNN',
  // Not in annex A (proposed with the commercial cycle): ports, container types, charge types and
  // currencies. Everyone reads them for dropdowns; only the Administrator changes them.
  master_data: 'FVVVVVVVV',
  users: 'FNNNNNNNN',
  audit_log: 'VVVNNNNNN',
};

/** Modules where the Driver sees and edits only the trips assigned to them. */
export const DRIVER_OWN_TRIPS_ONLY: readonly PermissionModule[] = [
  'shipments',
  'transport_trips',
  'pod',
  'documents',
];

function isLevel(value: string | undefined): value is Level {
  return value === 'F' || value === 'A' || value === 'E' || value === 'V' || value === 'N';
}

function buildRolePermissions(): Record<Role, ReadonlySet<Permission>> {
  const result = {} as Record<Role, Set<Permission>>;
  ROLES.forEach((role, roleIndex) => {
    const permissions = new Set<Permission>();
    for (const module of PERMISSION_MODULES) {
      const level = PERMISSION_MATRIX[module][roleIndex];
      if (!isLevel(level)) {
        throw new Error(`Invalid permission matrix cell for ${module}/${role}`);
      }
      for (const action of LEVEL_ACTIONS[level]) {
        permissions.add(`${module}:${action}`);
      }
    }
    result[role] = permissions;
  });
  return result;
}

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> =
  buildRolePermissions();

/**
 * Annex A, "shipment profitability and costs (Restricted)": who sees what transport cost (a hired
 * trip's agreed cost, how a trip's cost was shared between shipments, the cost column of the trips
 * report). Holders of shipment_profitability:view, and those who plan trips and agree the cost
 * with a carrier (transport_fleet:create); not Sales, Warehouse, Customs or Drivers.
 */
export function seesTransportCosts(has: (permission: Permission) => boolean): boolean {
  return has('shipment_profitability:view') || has('transport_fleet:create');
}

/** Permissions of a user holding several roles: the union (annex A). Sorted for stable output. */
export function permissionsForRoles(roles: readonly Role[]): Permission[] {
  const all = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      all.add(permission);
    }
  }
  return [...all].sort();
}

export function hasAllBranchAccess(roles: readonly Role[]): boolean {
  return roles.some((role) => ALL_BRANCH_ROLES.includes(role));
}

/** Shape of GET /auth/me. */
export interface AuthMeResponse {
  id: string;
  email: string;
  fullName: string;
  preferredLocale: string;
  roles: Role[];
  permissions: Permission[];
  allBranches: boolean;
  branches: { id: string; code: string; nameEn: string; nameAr: string }[];
  /**
   * The staff AI assistant's address, or null when none is configured. The assistant reads only
   * what this user may read: NOLON rechecks the user's roles and branches on every request.
   */
  assistantUrl: string | null;
}
