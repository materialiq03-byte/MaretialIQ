'use client';

/**
 * Phase UI-6 — breadcrumb island (client). The UI-1 shell derived the top-bar
 * breadcrumb from the `x-invoke-path` / `next-url` request headers, which the
 * current Next.js runtime no longer supplies — every route degraded to
 * "Dashboard". This island reads the real client pathname (same mechanism the
 * sidebar island already uses) and re-renders the same label through the
 * unchanged pure `breadcrumbFor` mapping. Presentation only: the label map and
 * authorization-driven navigation are untouched.
 */
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { breadcrumbFor } from './breadcrumb';

export default function Breadcrumb({ serverFallback }: { serverFallback: string }) {
  const pathname = usePathname();
  const [label, setLabel] = useState<string>(serverFallback);

  // Hydration-safe: first paint keeps the server-computed fallback; this
  // island then corrects the label from the real client route.
  useEffect(() => {
    setLabel(breadcrumbFor(pathname));
  }, [pathname]);

  return <span className="hq-breadcrumb">Material Intelligence / {label}</span>;
}
