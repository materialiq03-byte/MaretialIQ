import type { DashboardMetrics } from '@/lib/db/repositories/metrics-repository';

export function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export function DashboardTable({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="table-wrap">
    <table>
      <thead>
        <tr>
          {headers.map((h, i) => (
            <th key={h} className={i > 0 && (h === 'Records' || h === 'Candidates' || h === 'Rows' || h === 'OK' || h === 'Failed' || h === 'Pending') ? 'num' : undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
    </div>
  );
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

/**
 * Compact server-rendered horizontal bar chart — no client JS needed.
 * Every value comes straight from the metrics repository (FR-16).
 */
export function MiniBars({
  rows,
  title,
}: {
  rows: Array<{ label: string; n: number }>;
  title: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="mini-bars">
      <div className="section-label">{title}</div>
      {rows.length === 0 ? (
        <EmptyHint>No data yet.</EmptyHint>
      ) : (
        rows.map((r) => (
          <div className="mini-bar-row" key={r.label}>
            <span className="mini-bar-label">{r.label}</span>
            <span className="mini-bar-track">
              <span className="mini-bar-fill" style={{ width: `${Math.round((r.n / max) * 100)}%` }} />
            </span>
            <span className="mini-bar-value">{r.n}</span>
          </div>
        ))
      )}
    </div>
  );
}

export type { DashboardMetrics };
