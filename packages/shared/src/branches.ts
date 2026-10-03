/** Operating branches. Every branch-owned record and query is scoped to one of these. */
export const BRANCH_CODES = ['DXB', 'JED', 'PTS', 'ATB', 'KRT'] as const;

export type BranchCode = (typeof BRANCH_CODES)[number];

export function isBranchCode(value: unknown): value is BranchCode {
  return typeof value === 'string' && (BRANCH_CODES as readonly string[]).includes(value);
}
