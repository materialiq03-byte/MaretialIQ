/**
 * Role → permission matrix. The single source of truth for authorization:
 * pages call `requirePermission`, API routes call `requireApiPermission`,
 * and the navigation renders from `navForRole`. Role checks scattered in
 * components are a defect — this module owns the mapping.
 */
import type { Role } from './types';

export const PERMISSIONS = [
  'VIEW_DASHBOARD',
  'VIEW_MATERIALS',
  'IMPORT_MATERIALS',
  'EDIT_MATERIALS',
  'RUN_MATCHING',
  'VIEW_MATCHES',
  'REVIEW_MATCHES',
  'APPROVE_MATCH',
  'REJECT_MATCH',
  'DEFER_MATCH',
  'CREATE_COMMON_IDENTITY',
  'VIEW_MAPPINGS',
  'VIEW_ANALYTICS',
  'VIEW_AUDIT',
  'MANAGE_USERS',
  'MANAGE_ORGANIZATIONS',
  'MANAGE_SYSTEM_SETTINGS',
  /** Step 18: create/approve/reject/disable/re-enable DOMAIN_SPECIFIC UOM rules. */
  'MANAGE_UOM_RULES',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const CPSE_MANAGER: Permission[] = [
  'VIEW_DASHBOARD',
  'VIEW_MATERIALS',
  'IMPORT_MATERIALS',
  'EDIT_MATERIALS',
  'VIEW_MATCHES',
  'VIEW_MAPPINGS',
  'VIEW_ANALYTICS',
];

const CPSE_REVIEWER: Permission[] = [
  'VIEW_DASHBOARD',
  'VIEW_MATERIALS',
  'VIEW_MATCHES',
  'REVIEW_MATCHES',
  'APPROVE_MATCH',
  'REJECT_MATCH',
  'DEFER_MATCH',
  'RUN_MATCHING',
  'CREATE_COMMON_IDENTITY',
  'VIEW_MAPPINGS',
  'VIEW_AUDIT',
];

const AUTHORITY: Permission[] = [
  'VIEW_DASHBOARD',
  'VIEW_MATERIALS',
  'VIEW_MATCHES',
  'VIEW_MAPPINGS',
  'VIEW_ANALYTICS',
  'VIEW_AUDIT',
  /** Step 18: the authority role governs scoped UOM conversions. */
  'MANAGE_UOM_RULES',
];

const PLATFORM_ADMIN: Permission[] = [...PERMISSIONS];

/** Least-privilege: authority deliberately lacks write permissions. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  cpse_material_manager: CPSE_MANAGER,
  cpse_technical_reviewer: CPSE_REVIEWER,
  authority: AUTHORITY,
  platform_admin: PLATFORM_ADMIN,
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/** Navigation entries with the permission that unlocks each. */
export interface NavItem {
  href: string;
  label: string;
  permission: Permission;
  /** Demo-flow section shown above the link in the navigation. */
  group: 'DATA' | 'INTELLIGENCE' | 'HARMONIZATION' | 'INSIGHTS' | 'SYSTEM';
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', permission: 'VIEW_DASHBOARD', group: 'DATA' },
  { href: '/materials', label: 'Material Master', permission: 'VIEW_MATERIALS', group: 'DATA' },
  { href: '/procurement', label: 'Procurement', permission: 'VIEW_MAPPINGS', group: 'DATA' },
  { href: '/imports', label: 'Import Center', permission: 'IMPORT_MATERIALS', group: 'DATA' },
  { href: '/integrations', label: 'CPSE Integrations', permission: 'IMPORT_MATERIALS', group: 'DATA' },
  { href: '/matching', label: 'AI Matching', permission: 'VIEW_MATCHES', group: 'INTELLIGENCE' },
  { href: '/proposals', label: 'Review Queue', permission: 'VIEW_MATCHES', group: 'INTELLIGENCE' },
  { href: '/cross-reference', label: 'Common Materials & Mappings', permission: 'VIEW_MAPPINGS', group: 'HARMONIZATION' },
  { href: '/analytics', label: 'Analytics', permission: 'VIEW_ANALYTICS', group: 'INSIGHTS' },
  { href: '/evaluation', label: 'Matching Evaluation', permission: 'VIEW_ANALYTICS', group: 'INSIGHTS' },
  { href: '/audit', label: 'Audit Trail', permission: 'VIEW_AUDIT', group: 'INSIGHTS' },
  { href: '/admin', label: 'Administration', permission: 'MANAGE_USERS', group: 'SYSTEM' },
];

export function navForRole(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => roleHasPermission(role, item.permission));
}

/** Nav items grouped in demo-flow order; empty groups are omitted. */
export function navGroupsForRole(role: Role): Array<{ group: NavItem['group']; items: NavItem[] }> {
  const order: NavItem['group'][] = ['DATA', 'INTELLIGENCE', 'HARMONIZATION', 'INSIGHTS', 'SYSTEM'];
  const items = navForRole(role);
  return order
    .map((group) => ({ group, items: items.filter((i) => i.group === group) }))
    .filter((g) => g.items.length > 0);
}
