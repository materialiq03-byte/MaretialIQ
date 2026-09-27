/**
 * Phase UI-1 — breadcrumb derivation for the top bar. Maps the pathname to
 * real page context; unknown paths degrade to their last segment. Kept as a
 * pure function so the server shell can render it without client JS.
 */
const TRAIL: Record<string, string> = {
  '/': 'Dashboard',
  '/materials': 'Material Master',
  '/matching': 'Matching',
  '/proposals': 'Review Queue',
  '/cross-reference': 'Common Materials',
  '/imports': 'Import Center',
  '/integrations': 'CPSE Integrations',
  '/procurement': 'Procurement',
  '/procurement/opportunities': 'Opportunities',
  '/procurement/suppliers': 'Supplier Intelligence',
  '/procurement/uom-rules': 'UOM Rules',
  '/procurement/uom-steward': 'UOM Steward',
  '/procurement/governance': 'Governance Cockpit',
  '/procurement/import': 'Procurement Import',
  '/evaluation': 'Evaluation',
  '/analytics': 'Analytics',
  '/audit': 'Audit Trail',
  '/admin': 'Administration',
  '/settings': 'Settings',
};

export function breadcrumbFor(pathname: string): string {
  const clean = pathname.split('?')[0].replace(/\/+$/, '') || '/';
  if (TRAIL[clean]) return TRAIL[clean];
  // Detail routes: /matching/123 → Matching / #123, /materials/7 → Material Master / #7
  const segments = clean.split('/').filter(Boolean);
  if (segments.length >= 2) {
    const parent = TRAIL['/' + segments[0]] ?? segments[0];
    return `${parent} / ${segments.slice(1).join(' / ')}`;
  }
  return segments[0] ?? 'Dashboard';
}
