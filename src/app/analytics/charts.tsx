'use client';

/**
 * Recharts visualisations for the analytics page (TRD §18 names Recharts as
 * the prototype charting library). Pure presentation — every value arrives
 * from analytics-service SQL aggregates.
 */
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie,
  Cell, Legend, CartesianGrid,
} from 'recharts';
import type { AnalyticsData } from '@/lib/services/analytics-service';

const PALETTE = ['#2563eb', '#0891b2', '#059669', '#d97706', '#7c3aed', '#dc2626', '#64748b'];

const BLOCK = { border: '1px solid var(--border, #e2e8f0)', borderRadius: 8, padding: '12px 16px', background: '#fff' };
const TITLE = { fontWeight: 600, margin: '4px 0 12px' } as const;

export function DecisionPie({ data }: { data: AnalyticsData['decisions'] }) {
  return (
    <div style={BLOCK}>
      <div style={TITLE}>Match decision states (persisted candidates)</div>
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie data={data} dataKey="n" nameKey="decision" outerRadius={90} label={(props: { value?: number | string }) => (props.value != null ? `${props.value}` : '')}>
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CategoryBar({ data }: { data: AnalyticsData['materialsByCategory'] }) {
  return (
    <div style={BLOCK}>
      <div style={TITLE}>Material records by category</div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="category" />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="n" name="Records" fill="#2563eb" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CpseBar({ data }: { data: AnalyticsData['materialsByOrg'] }) {
  return (
    <div style={BLOCK}>
      <div style={TITLE}>Material records by CPSE</div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="code" />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="n" name="Records" fill="#0891b2" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ConflictBar({ data }: { data: AnalyticsData['topConflicts'] }) {
  return (
    <div style={BLOCK}>
      <div style={TITLE}>Top pending critical conflicts (by attribute)</div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} layout="vertical" margin={{ left: 40 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" allowDecimals={false} />
          <YAxis type="category" dataKey="attribute" width={120} />
          <Tooltip />
          <Bar dataKey="n" name="Candidate pairs" fill="#d97706" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
