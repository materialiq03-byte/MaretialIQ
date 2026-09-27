import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/guard';
import { findUserByEmail } from '@/lib/auth/user-repository';
import { verifyPassword } from '@/lib/auth/password';
import { config } from '@/lib/config';
import LoginForm from './login-form';

export const dynamic = 'force-dynamic';

/**
 * SIH PROTOTYPE MODE (default): login is intentionally out of the user flow —
 * any visitor is sent straight to the dashboard. The full authentication UI
 * below stays in the codebase and reactivates when REQUIRE_AUTH=true.
 * PROTOTYPE-ONLY configuration, not production auth.
 */
const DEMO_PASSWORD_ENV = process.env.DEMO_PASSWORD ?? 'demo-password';

/**
 * The demo password is deliberately NOT hardcoded here. It exists only if the
 * operator seeded demo accounts with DEMO_PASSWORD (default for local dev:
 * the value documented in README). We probe one known demo account so the
 * helper section only appears when demo users actually exist.
 */
async function demoAccountsExist(): Promise<boolean> {
  try {
    const user = findUserByEmail('cpcl.manager@materialiq.demo');
    if (!user) return false;
    return verifyPassword(DEMO_PASSWORD_ENV, user.password_hash);
  } catch {
    return false;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (user || config.prototypeMode) redirect('/');

  const sp = await searchParams;
  const next = typeof sp.next === 'string' && sp.next.startsWith('/') && !sp.next.startsWith('//') ? sp.next : '';
  const showDemo = await demoAccountsExist();

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="site-title">MaterialIQ</div>
          <p className="subtitle">
            AI-Powered Material Intelligence &amp; Harmonization Platform
          </p>
        </div>
        <LoginForm demoPassword={showDemo ? DEMO_PASSWORD_ENV : null} next={next} />
        <p className="demo-note login-note">{config.demo.label}</p>
      </div>
    </main>
  );
}
