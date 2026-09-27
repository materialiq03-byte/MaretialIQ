import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';
import { getCurrentUser } from '@/lib/auth/guard';
import { config } from '@/lib/config';
import AppShell from '@/components/app-shell';
import { THEME_BOOTSTRAP } from '@/components/theme-bootstrap';
import type { SessionUser } from '@/lib/auth/types';

export const metadata: Metadata = {
  title: 'MaterialIQ — Material Harmonization Review Console',
  description:
    'Cross-CPSE material harmonization with deterministic matching, evidence-based review and human approval. Demo database.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let user: SessionUser | null = null;
  try {
    user = await getCurrentUser();
  } catch {
    user = null; // e.g. login page before any session exists
  }

  if (user) {
    return (
      <html lang="en">
        <head>
          {/* Phase UI-1: apply persisted theme before first paint (no flash). */}
          <Script id="theme-bootstrap" strategy="beforeInteractive">{THEME_BOOTSTRAP}</Script>
        </head>
        <body>
          <AppShell
            user={user}
            demoLabel={config.prototypeMode ? config.demo.prototypeBadge : config.demo.label}
          >
            {children}
          </AppShell>
        </body>
      </html>
    );
  }

  /* REQUIRE_AUTH=true path: no identity — plain header with Sign-in link. */
  return (
    <html lang="en">
      <head>
        <Script id="theme-bootstrap" strategy="beforeInteractive">{THEME_BOOTSTRAP}</Script>
      </head>
      <body>
        <header className="site-header">
          <div className="inner">
            <div className="site-title">
              MaterialIQ <span>· material harmonization review console</span>
            </div>
            <nav className="nav" aria-label="Primary">
              <a href="/login">Sign in</a>
            </nav>
          </div>
        </header>
        <div className="page">
          <div className="demo-note">{config.demo.label}</div>
          {children}
        </div>
      </body>
    </html>
  );
}
