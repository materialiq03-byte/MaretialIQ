'use client';

/**
 * Phase UI-1 — sidebar navigation (client island).
 *
 * Renders the permission-filtered groups passed from the server shell, adds
 * active-route highlighting via usePathname, and provides the mobile drawer
 * behavior (hamburger in the top bar toggles an overlay; Escape closes;
 * backdrop click closes; navigation closes it). Groups/labels stay owned by
 * the server shell (navGroupsForRole remains the authorization source) — this
 * island only adds interactivity.
 */
import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

export interface NavGroupData {
  group: string;
  items: Array<{ href: string; label: string }>;
}

export default function SidebarNav({ groups }: { groups: NavGroupData[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  // Close the drawer on navigation (route or query change).
  useEffect(() => {
    setOpen(false);
  }, [pathname, searchParams]);

  // Escape closes the drawer; lock scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  const currentQuery = searchParams?.toString() ?? '';

  function isActive(href: string): boolean {
    const [path, query] = href.split('?');
    if (pathname !== path) return false;
    if (query) return currentQuery.includes(query);
    // A bare link is not active when a more specific variant is selected.
    return !(path === '/cross-reference' && currentQuery.includes('view='));
  }

  return (
    <>
      {/* Mobile drawer backdrop */}
      {open ? (
        <button
          type="button"
          className="hq-drawer-backdrop"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      ) : null}
      <nav className={`hq-nav${open ? ' hq-nav-open' : ''}`} aria-label="Primary">
        {groups.map(({ group, items }) => (
          <div key={group} className="hq-nav-group">
            <span className="hq-nav-label">{group}</span>
            {items.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={`hq-nav-link${isActive(item.href) ? ' hq-nav-active' : ''}`}
                aria-current={isActive(item.href) ? 'page' : undefined}
              >
                {item.label}
              </a>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}
