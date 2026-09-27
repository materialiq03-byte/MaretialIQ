'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function OrgForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: form.get('code'),
          name: form.get('name'),
          description: form.get('description') || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? `Failed (HTTP ${res.status}).`);
        return;
      }
      setSuccess(`Organization ${String(form.get('code'))} created.`);
      e.currentTarget.reset();
      router.refresh();
    } catch {
      setError('Network error — organization not created.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="login-form" style={{ maxWidth: 480 }}>
      <label className="fld">
        Code (2–10 uppercase letters/digits)
        <input name="code" required minLength={2} maxLength={10} pattern="[A-Z0-9]+" placeholder="E.g. ONGC" />
      </label>
      <label className="fld">
        Name
        <input name="name" required minLength={2} maxLength={120} placeholder="Oil and Natural Gas Corporation (synthetic demo)" />
      </label>
      <label className="fld">
        Description (optional)
        <input name="description" maxLength={500} />
      </label>
      {error ? <div className="error-box">{error}</div> : null}
      {success ? <div className="info-box">{success}</div> : null}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create organization'}
      </button>
    </form>
  );
}
