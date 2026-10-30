/**
 * Roles and permissions, transcribed from annex A (02a-annex-permissions.md). The matrix is each
 * role's default: the owner changes a role's team, a branch or a person from the permissions
 * screen (docs/plans/03-permissions-screen.md), stored as changes on top of these defaults.
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
  'customer_profiles',
  'customer_profile_intake',
  'customer_profile_followup',
  'rates',
  'rate_costs',
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
  'partner_contracts',
  // Plan 07 section 8: partner commissions (rule 16) and statements (rule 16a). view: rows,
  // holds and statements; create: making a statement; update: cancelling a draft statement;
  // approve: a manual adjustment (apart from making statements on purpose).
  'partner_commissions',
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
  // Plan 03: who may do what (the permissions screen). The Administrator only, never given.
  'access_control',
  // Plan 04a: staff review of the shipping bot's booking requests. view: the list; update:
  // routing to a branch; approve: approval and rejection.
  'cs_booking_requests',
  // Plan 04 section 4.1: how a customer pays, per branch and currency. create/update: drafts;
  // approve: by another person than its maker; cancel: retiring one.
  'payment_instructions',
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
  customer_profiles: 'NNNNNNNNNNN',
  customer_profile_intake: 'NNNNNNNNNNN',
  customer_profile_followup: 'NNNNNNNNNNN',
  customers: 'FVFFVVVVNFE',
  // Owner, 2026-10-19: only the Sales & Marketing Manager (and the Administrator) make, edit,
  // approve and cancel rate cards; every other role reads them, for every branch.
  rates: 'FVVVVVNNNFV',
  // Business model plan 4.1: a rate card's reference costs and expected margin, apart from `rates`
  // so Sales and Operations see a price without its cost and margin.
  rate_costs: 'FVVNNVNNNFN',
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
  // Business model plan 3.4 and 4.1: a partner's commission contracts (settings only in batch 1).
  partner_contracts: 'FVVNNVNNNFN',
  // Plan 07 section 8: Finance makes and cancels statements, the Branch Manager adjusts, and
  // Management and the Sales & Marketing Manager read.
  partner_commissions: 'FVANNENNNVN',
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
  access_control: 'FNNNNNNNNNN',
  // Plan 04a section 2 (⭐ proposed, in the owner's decisions file): those who book review them.
  cs_booking_requests: 'FVFFVNNNNFN',
  // Plan 04 section 4.1 (⭐ proposed, in the owner's decisions file): Finance writes the drafts,
  // the Branch Manager approves and retires them (and Management approves), Sales reads them.
  payment_instructions: 'FAFVNENNNNN',
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

/** Every permission, in module order. */
export const PERMISSIONS: readonly Permission[] = PERMISSION_MODULES.flatMap((module) =>
  PERMISSION_ACTIONS.map((action): Permission => `${module}:${action}`),
);

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** The module of a permission (`customers:create` -> `customers`). */
export function permissionModule(permission: Permission): PermissionModule {
  return permission.slice(0, permission.indexOf(':')) as PermissionModule;
}

/**
 * Access control (docs/plans/03-permissions-screen.md, section 4). Permissions are held per
 * branch. These modules hold no branch-owned rows: a person holds them when they hold them in
 * any of their branches.
 */
export const GLOBAL_MODULES: readonly PermissionModule[] = [
  'customer_profiles',
  'customer_profile_intake',
  'customer_profile_followup',
  'master_data',
  'fx_rates',
  'alert_settings',
  'users',
  'access_control',
];

/**
 * Modules only the Administrator team holds: no team change, branch grant or delegation gives
 * them, so nobody but an Administrator can raise anyone's access (plan 03, section 4).
 */
export const NON_GRANTABLE_MODULES: readonly PermissionModule[] = ['users', 'access_control'];

/**
 * Roles that are security scopes, not only sets of permissions (plan 03, F114-2): their row
 * filters read the role (the Driver's own trips, Outlet Staff's own outlets). They are given through user_roles only, their
 * team takes no added permission, and their holders take no other team or added permission.
 */
export const RESTRICTED_ROLES: readonly Role[] = ['DRIVER', 'OUTLET_STAFF'];

/**
 * Restricted roles whose team the owner may widen like any other team (owner, 2026-10-28: the
 * owner sets Outlet Staff's permissions, the matrix is only its default). Their row filter still
 * applies whatever the team holds; the Driver's team only loses permissions.
 */
export const WIDENABLE_RESTRICTED_ROLES: readonly Role[] = ['OUTLET_STAFF'];

/** Whether a team takes permissions beyond its defaults (an unrestricted or widenable team). */
export function takesAddedPermissions(team: {
  restricted: boolean;
  systemRole: Role | null;
}): boolean {
  return (
    !team.restricted ||
    (team.systemRole !== null && WIDENABLE_RESTRICTED_ROLES.includes(team.systemRole))
  );
}

/**
 * The permissions that work for Outlet Staff today: those of the routes built for the outlet
 * filter (@OutletScoped, checked by a test). Any other permission their team is given is held but
 * refused on every route until that route filters by outlet (plan 4.2).
 */
export const OUTLET_READY_PERMISSIONS: readonly Permission[] = [
  'bookings:create',
  'bookings:update',
  'bookings:view',
  'customers:create',
  'customers:update',
  'customers:view',
  'documents:create',
  'documents:view',
  'master_data:view',
  'partners:view',
  'quotations:create',
  'quotations:update',
  'quotations:view',
  'rates:view',
  'shipments:view',
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
   * Permissions are held per branch (plan 03): `permissions` above is their union, for menus;
   * a page about one branch's record shows its actions from that branch's list here.
   */
  branchPermissions?: { branchId: string; permissions: Permission[] }[];
  /** Plan 03: the live delegations this person holds (the branch-permissions screen). */
  delegations?: { id: string; branchId: string }[];
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
  /** Whether the users screen offers the Outlet Staff role (OUTLET_STAFF_ASSIGNABLE). */
  outletStaffAssignable: boolean;
}
