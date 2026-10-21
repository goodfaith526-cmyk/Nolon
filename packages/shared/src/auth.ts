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
  // Added after the annex (owner, 2026-10-19): makes and edits the rate cards every branch uses.
  'SALES_MARKETING_MANAGER',
  // Business model plan 4.2 (owner, 2026-10-21): staff of a partner sales outlet. Sees only the
  // customers, quotations, bookings, shipments and documents of their own outlets, and holds no
  // other role. Assigning it stays locked until the owner opens it (OUTLET_STAFF_ASSIGNABLE).
  'OUTLET_STAFF',
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
  'container_booking',
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
  'partners',
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
 * Admin, Management, Branch Mgr, Sales, Operations, Finance, Warehouse, Customs, Driver,
 * Sales & Marketing Mgr (added after the annex: Sales' access, and the rates in full),
 * Outlet Staff (business model plan 4.2: their own outlets' records only, see OUTLET_SCOPED).
 * "(own branch)" and "(own trips)" cells are view/edit here; branch scoping and the Driver's
 * own-trips filter (DRIVER_OWN_TRIPS_ONLY) narrow the rows.
 */
export const PERMISSION_MATRIX: Record<PermissionModule, string> = {
  customers: 'FVFFVVVVNFE',
  // Owner, 2026-10-19: only the Sales & Marketing Manager (and the Administrator) make, edit,
  // approve and cancel rate cards; every other role reads them, for every branch.
  rates: 'FVVVVVNNNFV',
  quotations: 'FVAFVVNNNFE',
  bookings: 'FVAFFVVVNFE',
  shipments: 'FVFVFVVVVVV',
  consolidation: 'FVFNFVVNNNN',
  // Not in annex A (owner, 2026-10-14): adding a booking to an open container of any branch, and
  // nothing else about containers (`container_booking:create`, with bookings:create and
  // bookings:approve). Sales got it so they can ship on an open container; editing, moving or
  // cancelling a container stays consolidation:update, and its costs stay hidden from them.
  container_booking: 'FNNEENNNNEN',
  warehouse: 'FVFVVVFVNVN',
  customs: 'FVFVVVNFNVN',
  transport_fleet: 'FVFNFVNNNNN',
  transport_trips: 'FVFVFVVNEVN',
  pod: 'FVFVFVFNEVN',
  documents: 'FVFEEEEEEEE',
  customer_invoices: 'FVAVVFNNNVN',
  credit_notes: 'FVANNENNNNN',
  receipts: 'FVVVNFNNNVN',
  suppliers: 'FVANEFNNNNN',
  // Business model (docs/plans/02-business-model-batch-1.md 4.1): the network's partners, owned by
  // a branch. Sales and Operations read them; Branch Manager and Sales & Marketing Mgr keep them.
  partners: 'FVFVVVNNNFV',
  supplier_payments: 'FVANNFNNNNN',
  expenses: 'FVANEFEEENN',
  manual_journals: 'FVNNNFNNNNN',
  chart_of_accounts: 'FVNNNANNNNN',
  fx_rates: 'FVNNNFNNNNN',
  shipment_profitability: 'FVVNNVNNNNN',
  financial_reports: 'FVVNNVNNNNN',
  operational_reports: 'FVVVVVVVNVN',
  dashboards: 'FVVVVVNNNVN',
  alert_settings: 'FNNNNNNNNNN',
  // Not in annex A (proposed with the commercial cycle): ports, container types, charge types and
  // currencies. Everyone reads them for dropdowns; only the Administrator changes them.
  master_data: 'FVVVVVVVVVV',
  users: 'FNNNNNNNNNN',
  audit_log: 'VVVNNNNNNNN',
};

/**
 * Modules an Outlet Staff user sees only for their own outlets (plan 4.2): customers acquired
 * through them, and the quotations, bookings, shipments and documents sold through them. Every
 * other module is closed to the role, and the API refuses the role on any route not built for it.
 */
export const OUTLET_SCOPED: readonly PermissionModule[] = [
  'customers',
  'quotations',
  'bookings',
  'shipments',
  'documents',
  'partners',
];

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
  /**
   * The user's branches. `today` is the branch's local date (YYYY-MM-DD) in its IANA `timezone`:
   * the day NOLON's date filters use for that branch, so "today" and "this month" match them.
   */
  branches: {
    id: string;
    code: string;
    nameEn: string;
    nameAr: string;
    timezone: string;
    today: string;
    /** The branch's default currency (ISO 4217), from the currencies master. */
    defaultCurrency: string;
  }[];
  /**
   * The staff AI assistant's address, or null when none is configured. The assistant reads only
   * what this user may read: NOLON rechecks the user's roles and branches on every request.
   */
  assistantUrl: string | null;
  /**
   * Whether the assistant opens as a panel beside NOLON's pages (it frames `assistantUrl`). Only
   * true when the assistant allows NOLON's address to frame it; false: the button opens a new tab.
   */
  assistantPanel: boolean;
}
