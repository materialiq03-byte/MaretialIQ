import { headers } from 'next/headers';
import { navGroupsForRole } from '@/lib/auth/permissions';
import type { SessionUser } from '@/lib/auth/types';
import UserMenu from './user-menu';
import SidebarNav, { type NavGroupData } from './sidebar-nav';
import HamburgerButton from './hamburger-button';
import ThemeToggle from './theme-toggle';
import { breadcrumbFor } from './breadcrumb';
import Breadcrumb from './breadcrumb-island';

/**
 * Phase UI-1 — the application shell: navy sidebar (grouped navigation,
 * active-route highlight, mobile drawer), enterprise top bar (real breadcrumb,
 * global material search, theme switch, session menu) and the workspace.
 *
 * Authorization stays in permissions.ts: navGroupsForRole(role) filters every
 * group item by permission before rendering. No fake links, no fake status.
 */

/**
 * Display grouping over the SAME permission-filtered items (navGroupsForRole
 * remains the authorization source — this only re-labels/re-orders groups and
 * adds display titles for items that need one).
 */
const GROUP_TITLES: Record<string, string> = {
  DATA: 'OVERVIEW & DATA',
  INTELLIGENCE: 'MATCHING',
  HARMONIZATION: 'MATERIAL GOVERNANCE',
  INSIGHTS: 'PROCUREMENT & INSIGHTS',
  SYSTEM: 'SYSTEM',
};

const ITEM_LABELS: Record<string, string> = {
  '/': 'Dashboard',
  '/materials': 'Materials',
  '/procurement': 'Procurement',
  '/matching': 'Matching Workspace',
  '/proposals': 'Review Queue',
  '/cross-reference': 'CMI & Mappings',
  '/imports': 'Import Center',
  '/integrations': 'CPSE Integrations',
  '/analytics': 'Analytics',
  '/evaluation': 'Evaluation',
  '/audit': 'Audit Trail',
  '/admin': 'Administration',
};

function displayGroups(role: SessionUser['role']): NavGroupData[] {
  return navGroupsForRole(role).map(({ group, items }) => ({
    group: GROUP_TITLES[group] ?? group,
    items: items.map((i) => ({ href: i.href, label: ITEM_LABELS[i.href] ?? i.label })),
  }));
}

export default async function AppShell({
  user,
  children,
  demoLabel,
}: {
  user: SessionUser;
  children: React.ReactNode;
  demoLabel: string;
}) {
  const h = await headers();
  // UI-6: the runtime no longer supplies x-invoke-path/next-url, so the
  // server-computed label would always be "Dashboard"; render it as the
  // pre-hydration fallback and let the breadcrumb island correct it from the
  // real pathname (same mechanism as the sidebar island).
  const breadcrumb = breadcrumbFor(h.get('x-invoke-path') ?? h.get('next-url') ?? '/');
  const groups = displayGroups(user.role);

  return (
    <div className="hq-shell">
      <aside className="hq-sidebar">
        <div className="hq-brand">
          <span className="hq-brand-name">MaterialIQ</span>
          <span className="hq-brand-sub">
            Material Intelligence &amp;
            <br />
            Harmonization Platform
          </span>
        </div>
        <SidebarNav groups={groups} />
        <div className="hq-sidebar-foot">
          <span className="hq-foot-dot" aria-hidden="true" />
          <span>
            SIH 2026
            <br />
            Prototype Environment
          </span>
        </div>
      </aside>
      <div className="hq-main">
        <header className="hq-topbar">
          <HamburgerButton />
          <Breadcrumb serverFallback={breadcrumb} />
          <form className="hq-search" action="/materials" method="get" role="search">
            <input
              type="search"
              name="q"
              placeholder="Search material code, description, manufacturer…"
              aria-label="Search materials"
            />
          </form>
          <span className="hq-topbar-status">
            <span className="hq-foot-dot" aria-hidden="true" /> Prototype Environment
          </span>
          <ThemeToggle />
          <UserMenu user={user} />
        </header>
        <div className="hq-workspace">
          {demoLabel ? <div className="demo-note">{demoLabel}</div> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
