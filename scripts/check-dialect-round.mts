/**
 * Manual check: run translated SQL against live Supabase (SELECT-only).
 * `npx tsx scripts/check-dialect-round.mts`
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { translateSql } from '../src/lib/db/dialect';

const env = readFileSync('.env.local', 'utf8');
const url = (env.split(/\r?\n/).find((l) => l.startsWith('MATERIALIQ_DATABASE_URL=')) || '')
  .split('=')
  .slice(1)
  .join('=')
  .trim();
const ca = readFileSync('certs/supabase-ca.crt', 'utf8');

const samples = [
  'SELECT CAST(ROUND(quantity * 100) AS INTEGER) AS s FROM procurement_records LIMIT 1',
  'SELECT CAST(ROUND(pr.quantity * unit_price * 100) AS INTEGER) AS s FROM procurement_records pr LIMIT 1',
  'SELECT ROUND(SUM(CAST(quantity AS REAL)) * 100) AS qty_cents FROM procurement_records LIMIT 1',
  "SELECT SUM(COALESCE(dr.factor, 1) * CAST(ROUND(pr.quantity * 100) AS INTEGER) * COALESCE(r.factor, 1)) AS s FROM procurement_records pr LEFT JOIN uom_domain_rules dr ON dr.status = 'APPROVED' AND dr.rule_type = 'DOMAIN_SPECIFIC' AND dr.cmi_id = pr.cmi_id AND dr.from_uom = UPPER(TRIM(pr.uom)) LEFT JOIN uom_conversion_rules r ON r.is_active = 1 AND r.rule_type IN ('ALIAS','SCALE') AND r.from_uom = UPPER(TRIM(pr.uom))",
];

console.log('--- translated SQL ---');
const client = new pg.Client({ connectionString: url, ssl: { ca, rejectUnauthorized: true } });
await client.connect();
for (const s of samples) {
  const translated = translateSql(s, 'postgresql');
  console.log('IN :', s);
  console.log('OUT:', translated);
  try {
    const r = await client.query(translated);
    console.log('OK :', JSON.stringify(r.rows.slice(0, 1)));
  } catch (e) {
    console.log('ERR:', (e as Error).message.slice(0, 120));
  }
  console.log('');
}
await client.end();
