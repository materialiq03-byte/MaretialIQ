'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ROLE_LABELS, type Role } from '@/lib/auth/types';

interface SwitchableUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  organizationCode: string | null;
}

/**
 * DEMO MODE only: lets a platform administrator create a real, DB-backed
 * session for another demo account so the genuine permission model is
 * exercised end to end. Nothing here can escalate privileges beyond the
 * target account's actual role.
 */
export default function DemoSwitcher({ users }: { users: SwitchableUser[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function switchTo(userId: number) {
    setBusy(userId);
    setError(null);
    try {
      const res = await fetch('/api/auth/demo-switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? `Failed (HTTP ${res.status}).`);
        return;
      }
      // A new session cookie was set server-side; refresh so the whole
      // shell (nav, dashboard) re-renders under the switched identity.
      router.push('/');
      router.refresh();
    } catch {
      setError('Network error — session not switched.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>
        Demo Role Switcher <span className="badge pending">DEMO MODE</span>
      </h2>
      <p className="subtitle">
        Development convenience only: switching creates a real session for the selected demo account and applies that
        account&apos;s actual role and organization scope. Disabled in production unless demo switching is explicitly
        enabled. Every switch is audit-logged.
      </p>
      {error ? <div className="error-box">{error}</div> : null}
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Role</th>
            <th>Organization</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.name} <span className="evidence-detail">({u.email})</span>
              </td>
              <td>{ROLE_LABELS[u.role]}</td>
              <td className="mono">{u.organizationCode ?? 'All organizations'}</td>
              <td>
                <button type="button" className="btn" disabled={busy !== null} onClick={() => switchTo(u.id)}>
                  {busy === u.id ? 'Switching…' : 'Switch session'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}
