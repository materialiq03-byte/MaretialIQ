'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const ROLES = [
  { value: 'cpse_material_manager', label: 'CPSE Material Manager' },
  { value: 'cpse_technical_reviewer', label: 'CPSE Technical Reviewer' },
  { value: 'authority', label: 'Authority' },
  { value: 'platform_admin', label: 'Platform Administrator' },
];
const CPSE_ROLES = new Set(['cpse_material_manager', 'cpse_technical_reviewer']);

export default function UserForm({ organizations }: { organizations: Array<{ id: number; code: string; name: string }> }) {
  const router = useRouter();
  const [role, setRole] = useState('cpse_material_manager');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.get('name'),
          email: form.get('email'),
          password: form.get('password'),
          role,
          organizationId: form.get('organizationId') || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? `Failed (HTTP ${res.status}).`);
        return;
      }
      setSuccess(`User ${String(form.get('email'))} created.`);
      router.refresh();
    } catch {
      setError('Network error — user not created.');
    } finally {
      setBusy(false);
    }
  }

  const needsOrg = CPSE_ROLES.has(role);

  return (
    <form onSubmit={submit} className="login-form" style={{ maxWidth: 480 }}>
      <label className="fld">
        Full name
        <input name="name" required minLength={2} maxLength={120} />
      </label>
      <label className="fld">
        Email
        <input name="email" type="email" required maxLength={200} placeholder="name@materialiq.demo" />
      </label>
      <label className="fld">
        Password (min 8 characters)
        <input name="password" type="password" required minLength={8} autoComplete="new-password" />
      </label>
      <label className="fld">
        Role
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="fld">
        Organization {needsOrg ? '(required for CPSE roles)' : '(not applicable — cleared on save)'}
        <select name="organizationId" required={needsOrg} disabled={!needsOrg} defaultValue="">
          <option value="">— none —</option>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.code} — {o.name.replace(' (synthetic demo)', '')}
            </option>
          ))}
        </select>
      </label>
      {error ? <div className="error-box">{error}</div> : null}
      {success ? <div className="info-box">{success}</div> : null}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create user'}
      </button>
    </form>
  );
}
