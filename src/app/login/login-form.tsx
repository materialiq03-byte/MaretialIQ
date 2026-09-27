'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const DEMO_ACCOUNTS = [
  { label: 'CPCL Manager', email: 'cpcl.manager@materialiq.demo', role: 'CPSE Material Manager' },
  { label: 'CPCL Reviewer', email: 'cpcl.reviewer@materialiq.demo', role: 'CPSE Technical Reviewer' },
  { label: 'NTPC Reviewer', email: 'ntpc.reviewer@materialiq.demo', role: 'CPSE Technical Reviewer' },
  { label: 'Authority', email: 'authority@materialiq.demo', role: 'Authority' },
  { label: 'Admin', email: 'admin@materialiq.demo', role: 'Platform Administrator' },
];

export default function LoginForm({ demoPassword, next }: { demoPassword: string | null; next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? `Sign-in failed (HTTP ${res.status}).`);
        return;
      }
      router.replace(next || '/');
      router.refresh();
    } catch {
      setError('Network error — could not reach the sign-in service.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="login-form">
        <label className="fld">
          Email
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@organization.example"
          />
        </label>
        <label className="fld">
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>
        {error ? <div className="error-box">{error}</div> : null}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign In'}
        </button>
      </form>

      {demoPassword ? (
        <div className="demo-accounts">
          <div className="section-label">Demo accounts — synthetic identities for this prototype</div>
          <p className="evidence-detail">
            These are not real government accounts. Clicking one fills the form; sign-in still runs the normal
            authenticated flow.
          </p>
          <div className="demo-grid">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.email}
                type="button"
                className="demo-account"
                onClick={() => {
                  setEmail(a.email);
                  setPassword(demoPassword);
                }}
              >
                <strong>{a.label}</strong>
                <span>{a.role}</span>
                <span className="mono">{a.email}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
