'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Reprocess control for one material. Calls the reprocess endpoint and
 * refreshes the server-rendered detail view. Shows the raw error text when
 * the pipeline rejects the request; nothing is silently swallowed.
 */
export default function ReprocessButton({ materialId }: { materialId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reprocess() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/materials/${materialId}/reprocess`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Reprocess failed (HTTP ${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={reprocess} disabled={busy}>
        {busy ? 'Reprocessing…' : 'Reprocess with current rules'}
      </button>
      {error ? <span className="error-box">{error}</span> : null}
      <span className="review-meta">
        Re-runs normalization, classification, extraction and quality checks. Original CPSE code and description are
        never modified.
      </span>
    </>
  );
}
