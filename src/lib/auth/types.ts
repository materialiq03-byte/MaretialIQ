/** Role, permission and session types. */

export const ROLES = [
  'cpse_material_manager',
  'cpse_technical_reviewer',
  'authority',
  'platform_admin',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  cpse_material_manager: 'CPSE Material Manager',
  cpse_technical_reviewer: 'CPSE Technical Reviewer',
  authority: 'Authority',
  platform_admin: 'Platform Administrator',
};

/** The authenticated identity resolved server-side from the session cookie. */
export interface SessionUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  /** CPSE organization id; null for authority/platform_admin. */
  organizationId: number | null;
  organizationCode: string | null;
  organizationName: string | null;
  /** Set when the session was created via the demo role switcher. */
  demoSwitched: boolean;
}
