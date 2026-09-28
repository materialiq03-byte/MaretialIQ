/**
 * Table-aware boolean-rewrite sanity check + live Supabase verification of
 * the two previously failing JOIN shapes (SELECT-only).
 *
 *   npx tsx scripts/check-boolean-translate.mts
 *   (live part needs MATERIALIQ_DATABASE_URL, read from .env.local when unset)
 */
import { readFileSync } from 'node:fs';
import { translateSql } from '../src/lib/db/dialect';

let failed = 0;
function check(name: string, actual: string, expect: RegExp | string, negate = false): void {
  const ok = negate
    ? !(typeof expect === 'string' ? actual.includes(expect) : expect.test(actual))
    : (typeof expect === 'string' ? actual.includes(expect) : expect.test(actual));
  console.log((ok ? ' ok - ' : ' not ok - ') + name);
  if (!ok) failed++;
  if (!ok) console.log('   got:', actual);
}

// 1. Integer-table is_active stays integer (suppliers, uom_conversion_rules).
check('suppliers.is_active = 1 untouched', translateSql("SELECT * FROM suppliers WHERE is_active = 1", 'postgresql'), 'is_active = 1');
check('uom rules join r.is_active = 1 untouched', translateSql("SELECT * FROM procurement_records pr LEFT JOIN uom_conversion_rules r ON r.is_active = 1 AND r.from_uom = 'EA'", 'postgresql'), 'r.is_active = 1');
check('suppliers.is_active <> 0 untouched', translateSql("SELECT * FROM suppliers WHERE is_active <> 0", 'postgresql'), 'is_active <> 0');

// 2. Qualified boolean-table refs are rewritten (baseline tables).
check('cm.is_active = 1 rewritten', translateSql("SELECT * FROM material_mappings ma JOIN common_materials cm ON cm.id = ma.cmi_id AND cm.is_active = 1", 'postgresql'), /cm\.is_active = true/);
check('m.is_active = 1 rewritten', translateSql("SELECT * FROM organizations o LEFT JOIN material_records m ON m.organization_id = o.id AND m.is_active = 1", 'postgresql'), /m\.is_active = true/);
check('bare common_materials alias-less rewritten', translateSql("SELECT id FROM common_materials WHERE is_active = 1", 'postgresql'), 'WHERE is_active = true');
check('material_records m.is_active <> 0 rewritten', translateSql("SELECT * FROM material_records m WHERE m.is_active <> 0", 'postgresql'), /m\.is_active <> false/);

// 3. Unrelated integer comparisons untouched.
check('amount = 10 untouched', translateSql("SELECT 1 WHERE amount = 10", 'postgresql'), 'amount = 10');

// 4. ROUND coercion still intact.
check('ROUND quantity coerced', translateSql("SELECT CAST(ROUND(quantity * 100) AS INTEGER) FROM procurement_records", 'postgresql'), /ROUND\(CAST\(CAST\(quantity AS REAL\) \* 100 AS numeric\)\)/);

console.log(failed === 0 ? 'ALL TRANSLATE CHECKS PASS' : failed + ' CHECKS FAILED');

// ---- live verification (SELECT-only) ----
if (failed === 0) {
  try {
    const env = readFileSync('.env.local', 'utf8');
    const url = (env.split(/\r?\n/).find((l) => l.startsWith('MATERIALIQ_DATABASE_URL=')) || '')
      .split('=').slice(1).join('=').trim();
    if (url) {
      process.env.MATERIALIQ_DATABASE_URL = url;
      process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
      const pg = (await import('pg')).default;
      const ca = readFileSync('certs/supabase-ca.crt', 'utf8');
      const c = new pg.Client({ connectionString: url, ssl: { ca, rejectUnauthorized: true } });
      await c.connect();
      // Integer-table join (previously would be broken by a blanket rewrite).
      const q1 = translateSql("SELECT COUNT(*)::int AS n FROM procurement_records pr LEFT JOIN uom_conversion_rules r ON r.is_active = 1 AND r.rule_type IN ('ALIAS','SCALE') AND r.from_uom = UPPER(TRIM(pr.uom))", 'postgresql');
      console.log('live integer-join:', JSON.stringify((await c.query(q1)).rows));
      // Boolean-table join (needs the rewrite).
      const q2 = translateSql("SELECT COUNT(*)::int AS n FROM material_mappings ma JOIN common_materials cm ON cm.id = ma.cmi_id AND cm.is_active = 1", 'postgresql');
      console.log('live boolean-join:', JSON.stringify((await c.query(q2)).rows));
      await c.end();
      console.log('LIVE CHECKS PASS');
    } else {
      console.log('(live checks skipped: no MATERIALIQ_DATABASE_URL in .env.local)');
    }
  } catch (e) {
    console.log('LIVE CHECK ERROR:', (e as Error).message.slice(0, 90));
    failed++;
  }
}

process.exit(failed === 0 ? 0 : 1);
