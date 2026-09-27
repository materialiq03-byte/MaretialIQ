'use strict';
/**
 * Step 22 — CPSE integration layer tests.
 *
 * `npx tsx tests/cpse-integration.test.ts` (part of the chain).
 *
 *   1-5.   the five source adapters (CPCL/NTPC/BHEL/NLC/SAIL) parse their
 *          synthetic feeds into canonical rows with declared vocabularies
 *   6-7.   adapter registry: resolution, one adapter per CPSE, fail-closed
 *          unknown ids; adapter versions are stable contract ids
 *   8.     canonical transformation: identity, verbatim source text, metadata
 *   9.     required-field validation (structured {row,field,code,message})
 *   10.    malformed source rows fail validation
 *   11.    unknown source fields retained in sourceMetadata (never dropped)
 *   12.    duplicate source records within a feed → DUPLICATE_SOURCE_RECORD
 *   13.    idempotent repeated ingestion (no uncontrolled duplicates)
 *   14.    CPSE isolation: adapter identity is fixed, fail-closed
 *   15.    source traceability (CPSE→source→import→material→source_row)
 *   16.    CSV ingestion end-to-end (existing async import pipeline)
 *   17.    XLSX feed rides the same existing parsing engine
 *   18.    source preview + quality report computed from ACTUAL data
 *   19.    validation summary counts are real
 *   20.    async job integration (existing job model, COMPLETED)
 *   21.    authorization: integration endpoints scoped server-side
 *   22.    audit behavior: mutation events reuse existing import vocabulary
 *   23.    failed import safety: validation errors import NOTHING
 *   24.    existing material parity: rows identical to Import Center imports
 *   25.    matching parity: CP-1001↔NT-8821 / SL-7721 / BH-4410 intact
 *   26-30. Step 17/18/19/20/21 regressions
 *   31.    description is NEVER the source identity (explicit non-goal)
 *   32.    registry API shape exposes no secrets
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import {
  CPCL_ADAPTER,
  NTPC_ADAPTER,
  BHEL_ADAPTER,
  NLC_ADAPTER,
  SAIL_ADAPTER,
} from '../src/lib/integrations/adapters';
import { getAdapterByCpseRequired, getAdapterRequired, listAdapters } from '../src/lib/integrations/registry';
import { analyzeIntegration, executeIntegration, getIntegrationRun } from '../src/lib/integrations/integration-service';
import { sourceIdentityOf } from '../src/lib/integrations/canonical-contract';
import { normalizeVocabularyValue, codeConflictsWithDescription } from '../src/lib/integrations/adapter-interface';
import { getImportRequired } from '../src/lib/db/repositories/import-repository';
import { countAudit } from '../src/lib/db/repositories/audit-repository';
import { runPipeline } from '../src/lib/pipeline';
import { SEED } from '../scripts/seed-data';
import {
  createSupplierRecord,
  createProcurementRecord,
  normalizeQuantity,
  getUomRuleRegistry,
  getCmiComparableDemand,
  getEffectiveUomRule,
  createUomDomainRule,
  transitionUomRuleLifecycle,
  proposeUomRuleAmendment,
  decideUomRuleAmendment,
  getUomRuleVersions,
  getUomRuleHistory,
  getGovernanceCockpit,
} from '../src/lib/services/procurement-service';
import { runMatching, decideMatch } from '../src/lib/services/matching-service';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  process.env.CMI_SHORT_CIRCUIT = 'off';
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
    console.log(`  FAIL - ${name}: ${(e as Error).message}`);
  }
}

const ACTOR = 'integrator22@demo';

interface Fixture {
  db: DatabaseSync;
  dir: string;
  orgIds: Record<string, number>;
  feed: (cpse: string) => string;
}

function feedPath(cpse: string): string {
  return path.join(process.cwd(), 'data', 'cpse-feeds', `${cpse}-materials.csv`);
}

function baseFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-cpse22-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  setDbForTests(db);
  const now = new Date().toISOString();
  const insOrg = db.prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`);
  const orgIds: Record<string, number> = {};
  for (const [code, name] of [
    ['CPCL', 'Chennai Petroleum (demo)'],
    ['NTPC', 'NTPC Limited (demo)'],
    ['BHEL', 'Bharat Heavy Electricals (demo)'],
    ['NLC', 'Neyveli Lignite (demo)'],
    ['SAIL', 'Steel Authority of India (demo)'],
  ]) {
    orgIds[code] = Number(insOrg.run(code, name, now, now).lastInsertRowid);
  }
  return { db, dir, orgIds, feed: feedPath };
}

function feedOf(cpse: string): string {
  return fs.readFileSync(feedPath(cpse), 'utf8');
}

/**
 * Insert one seeded material EXACTLY the way scripts/seed.ts does — the real
 * pipeline + the shared synthetic dataset — so parity tests exercise the
 * same record shape as the demo database (attributes included).
 */
function seedMaterial(f: Fixture, orgCode: string, code: string): number {
  const orgSeed = SEED.find((o) => o.code === orgCode);
  const m = orgSeed?.materials.find((x) => x.code === code);
  assert.ok(orgSeed && m, `seed data for ${orgCode}:${code} must exist`);
  const out = runPipeline({ originalDescription: m.description, categoryOverride: m.category });
  const res = f.db
    .prepare(
      `INSERT INTO material_records
         (organization_id, original_code, original_description, normalized_description,
          category, subcategory, manufacturer, model, part_number, material_type, uom, import_id,
          processing_status, classification_confidence, classification_source, quality_status, quality_checks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      f.orgIds[orgCode],
      m.code,
      m.description,
      out.normalizedDescription,
      out.classification.category ?? m.category,
      out.classification.subcategory ?? m.subcategory ?? null,
      m.manufacturer ?? null,
      m.model ?? null,
      null,
      m.materialType ?? null,
      m.uom ?? 'NOS',
      out.processingStatus,
      out.classification.confidence,
      out.classification.source,
      out.quality.status,
      JSON.stringify(out.quality.checks),
    );
  const materialId = Number(res.lastInsertRowid);
  for (const a of out.attributes) {
    f.db
      .prepare(
        `INSERT INTO material_attributes
           (material_id, attribute_name, value, normalized_value, unit, is_critical, extraction_method, confidence)
         VALUES (?, ?, ?, ?, ?, ?, 'rule', ?)`,
      )
      .run(materialId, a.attributeName, a.value, a.normalizedValue ?? null, a.unit ?? null, a.isCritical ? 1 : 0, a.confidence ?? null);
  }
  return materialId;
}

/* ------------------------- 1-5: the five adapters ------------------------- */

test('1. CPCL adapter: declared mapping + vocabulary normalization on the synthetic feed', () => {
  const a = analyzeIntegration({ adapterId: 'CPCL', fileName: 'CPCL-materials.csv', payload: feedOf('CPCL') });
  assert.equal(a.cpse, 'CPCL');
  assert.equal(a.adapterVersion, 'CPCL-MATERIAL-v1');
  assert.equal(a.rowsReceived, 5);
  assert.equal(a.rowsValid, 5);
  assert.equal(a.canExecute, true);
  const first = a.canonicalPreview[0];
  assert.equal(first.sourceRecordId, 'CP-9001');
  assert.equal(first.category, 'Bearings', 'BRG → Bearings via declared vocabulary');
  assert.equal(first.uom, 'NOS');
  assert.deepEqual(
    a.fieldMapping.map((m) => `${m.sourceField}>${m.canonicalField}`).sort(),
    ['MAT_CODE>materialCode', 'MAT_DESC>description', 'MAT_GRADE>material', 'MAT_GROUP>category', 'MFR>manufacturer', 'PART_NO>partNumber', 'UOM>uom'].sort(),
  );
});

test('2. NTPC adapter: verbose ERP headers map into the same canonical contract', () => {
  const a = analyzeIntegration({ adapterId: 'NTPC', fileName: 'NTPC-materials.csv', payload: feedOf('NTPC') });
  assert.equal(a.adapterVersion, 'NTPC-MATERIAL-v1');
  assert.equal(a.rowsValid, 5);
  const first = a.canonicalPreview[0];
  assert.equal(first.sourceRecordId, 'NT-9401');
  assert.equal(first.category, 'Bearings');
  assert.equal(first.manufacturer, 'SKF');
  assert.equal(first.uom, 'EA');
});

test('3. BHEL adapter: item-master terminology maps into the same canonical contract', () => {
  const a = analyzeIntegration({ adapterId: 'BHEL', fileName: 'BHEL-materials.csv', payload: feedOf('BHEL') });
  assert.equal(a.adapterVersion, 'BHEL-MATERIAL-v1');
  assert.equal(a.rowsValid, 5);
  const first = a.canonicalPreview[0];
  assert.equal(first.sourceRecordId, 'BH-9301');
  assert.equal(first.material, '100CR6', 'material spec column preserved');
  assert.equal(first.category, 'Bearings');
});

test('4. NLC adapter: minimal headers + class codes map into the same canonical contract', () => {
  const a = analyzeIntegration({ adapterId: 'NLC', fileName: 'NLC-materials.csv', payload: feedOf('NLC') });
  assert.equal(a.adapterVersion, 'NLC-MATERIAL-v1');
  assert.equal(a.rowsValid, 5);
  const first = a.canonicalPreview[0];
  assert.equal(first.sourceRecordId, 'NL-9701');
  assert.equal(first.category, 'Bearings');
  assert.equal(first.uom, 'EA');
});

test('5. SAIL adapter: stock-item terminology maps into the same canonical contract', () => {
  const a = analyzeIntegration({ adapterId: 'SAIL', fileName: 'SAIL-materials.csv', payload: feedOf('SAIL') });
  assert.equal(a.adapterVersion, 'SAIL-MATERIAL-v1');
  assert.equal(a.rowsValid, 5);
  const first = a.canonicalPreview[0];
  assert.equal(first.sourceRecordId, 'SL-9101');
  assert.equal(first.category, 'Bearings');
  assert.equal(first.uom, 'EA', 'EACH → EA via declared vocabulary');
});

/* ------------------------------ 6-7: registry ----------------------------- */

test('6. adapter registry: all five resolvable, one per CPSE, fail-closed unknowns', () => {
  assert.deepEqual(listAdapters().map((a) => a.id), ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']);
  for (const cpse of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
    assert.equal(getAdapterByCpseRequired(cpse).cpse, cpse);
  }
  assert.throws(() => getAdapterRequired('TATA'), /not found/i);
  assert.throws(() => getAdapterByCpseRequired('ONGC'), /not found/i);
});

test('7. adapter versions are stable, declared contract ids', () => {
  for (const a of listAdapters()) {
    assert.match(a.version, /^[A-Z]+-MATERIAL-v\d+$/);
    assert.equal(a.supportedFormats.includes('CSV'), true);
  }
  assert.equal(CPCL_ADAPTER.version, 'CPCL-MATERIAL-v1');
  assert.equal(NTPC_ADAPTER.version, 'NTPC-MATERIAL-v1');
  assert.equal(BHEL_ADAPTER.version, 'BHEL-MATERIAL-v1');
  assert.equal(NLC_ADAPTER.version, 'NLC-MATERIAL-v1');
  assert.equal(SAIL_ADAPTER.version, 'SAIL-MATERIAL-v1');
});

/* ------------------------ 8: canonical transformation --------------------- */

test('8. canonical transformation: stable identity, verbatim source text, retained metadata', () => {
  const cpcl = CPCL_ADAPTER;
  const { canonical } = cpcl.validateAndTransform(
    { MAT_CODE: 'CP-TEST-1', MAT_DESC: 'SKF BALL BEARING 6205-2RS', MAT_GROUP: 'BRG', MFR: 'SKF', PART_NO: '6205-2RS', MAT_GRADE: 'EN31', UOM: 'NOS', LEGACY_BIN: 'Z-77' },
    42,
  );
  assert.ok(canonical);
  assert.equal(sourceIdentityOf(canonical), 'CPCL+CPCL+CP-TEST-1');
  assert.equal(canonical.sourceDescription, 'SKF BALL BEARING 6205-2RS', 'raw source text preserved verbatim');
  assert.equal(canonical.sourceMetadata['LEGACY_BIN'], 'Z-77', 'unknown source fields retained, never silently dropped');
  assert.equal(canonical.sourceRowNumber, 42);
  const missing = cpcl.validateAndTransform({ MAT_CODE: '', MAT_DESC: '' }, 7);
  assert.equal(missing.canonical, null);
});

/* --------------------------- 9-11: validation ----------------------------- */

test('9. required-field validation returns structured {row, field, code, message} errors', () => {
  const csv = 'MAT_CODE,MAT_DESC,MAT_GROUP,UOM\n,SKF BALL BEARING 6205-2RS,BRG,NOS\nCP-X,OK BEARING DESCRIPTION,BRG,NOS\n';
  const a = analyzeIntegration({ adapterId: 'CPCL', fileName: 'x.csv', payload: csv });
  assert.equal(a.rowsWithError, 1);
  const diag = a.diagnostics.find((d) => d.code === 'REQUIRED_FIELD');
  assert.ok(diag);
  assert.equal(diag.row, 2);
  assert.equal(diag.field, 'MAT_CODE');
  assert.ok(diag.message.includes('required'));
  assert.equal(a.canExecute, false, 'errors block execution');
});

test('10. malformed source rows: bad code characters and short descriptions fail validation', () => {
  const csv = 'MAT_CODE,MAT_DESC\nCP/BAD!!,X\nCP-OK,OK\n';
  const a = analyzeIntegration({ adapterId: 'CPCL', fileName: 'x.csv', payload: csv });
  assert.equal(a.rowsWithError, 2);
  assert.ok(a.diagnostics.some((d) => d.code === 'INVALID_VALUE' && d.field === 'MAT_CODE'));
  assert.ok(a.diagnostics.some((d) => d.code === 'INVALID_VALUE' && d.field === 'MAT_DESC'));
  // Unsupported format at the boundary.
  assert.throws(() => analyzeIntegration({ adapterId: 'CPCL', fileName: 'feed.xml', payload: '<x/>' }), /Unsupported source format/);
});

test('11. unknown source fields are retained in source metadata, never discarded', () => {
  const csv = 'MAT_CODE,MAT_DESC,MAT_GROUP,LEGACY_A,LEGACY_B\nCP-M1,FULL DESCRIPTION TEXT,BRG,AA1,BB2\n';
  const a = analyzeIntegration({ adapterId: 'CPCL', fileName: 'x.csv', payload: csv });
  assert.equal(a.rowsValid, 1);
  const row = a.canonicalPreview[0];
  assert.equal(row.sourceMetadata['LEGACY_A'], 'AA1');
  assert.equal(row.sourceMetadata['LEGACY_B'], 'BB2');
});

/* --------------------- 12-13: duplicates + idempotency -------------------- */

test('12. duplicate source records inside one feed are detected with stable identity', () => {
  const csv = 'MAT_CODE,MAT_DESC\nCP-DUP,FIRST DESCRIPTION HERE\nCP-DUP,SECOND DESCRIPTION HERE\n';
  const a = analyzeIntegration({ adapterId: 'CPCL', fileName: 'x.csv', payload: csv });
  assert.equal(a.duplicatesInFeed, 1);
  assert.equal(a.rowsWithError, 1);
  assert.ok(a.diagnostics.some((d) => d.message.includes('Duplicate source record')));
  assert.ok(a.diagnostics.some((d) => d.message.includes('CPCL+CPCL+CP-DUP')), 'identity exposed in diagnostics');
});

test('13. idempotent repeated ingestion: replaying the same feed creates no uncontrolled duplicates', () => {
  const f = baseFixture();
  const payload = feedOf('CPCL');
  const first = executeIntegration({ adapterId: 'CPCL', fileName: 'CPCL-materials.csv', payload, actor: ACTOR, sync: true });
  assert.equal(first.job.status, 'COMPLETED');
  assert.equal(first.canonicalRecordCount, 5);
  const countAfterFirst = Number((f.db.prepare(`SELECT COUNT(*) AS n FROM material_records`).get() as unknown as { n: number }).n);
  assert.equal(countAfterFirst, 5);

  // Replay variant: the same source record ids arrive through a different
  // file. The pure adapter is DB-blind (identity is detected per feed), so
  // the DB-authoritative net — UNIQUE(organization_id, original_code) + the
  // pipeline's duplicate-skip strategy — is what prevents duplicates.
  const variantFeed = 'MAT_CODE,MAT_DESC\nCP-9001,VARIANT DESCRIPTION TEXT\nCP-9002,ANOTHER VARIANT TEXT\n';
  const replay = executeIntegration({ adapterId: 'CPCL', fileName: 'CPCL-variant.csv', payload: variantFeed, actor: ACTOR, sync: true });
  assert.equal(replay.job.status, 'COMPLETED');
  assert.equal(replay.job.successfulRows, 0, 'duplicate-skip strategy kept all originals');
  assert.equal(
    Number((f.db.prepare(`SELECT duplicate_rows AS n FROM data_imports WHERE id = ?`).get(replay.importId) as unknown as { n: number }).n),
    2,
    'both replay rows accounted as skipped duplicates',
  );
  assert.equal(Number((f.db.prepare(`SELECT COUNT(*) AS n FROM material_records`).get() as unknown as { n: number }).n), 5, 'no duplicate materials after replay');
  // The originals are untouched — original code/description never overwritten.
  const orig = f.db.prepare(`SELECT original_description FROM material_records WHERE original_code = 'CP-9001'`).get() as unknown as { original_description: string };
  assert.equal(orig.original_description, 'SKF BALL BEARING 6205-2RS');
  f.db.close();
});

/* -------------------------- 14: CPSE isolation ---------------------------- */

test('14. CPSE isolation: each adapter writes only its own CPSE; identity never inferred', () => {
  const f = baseFixture();
  for (const cpse of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
    const out = executeIntegration({ adapterId: cpse, fileName: `${cpse}-materials.csv`, payload: feedOf(cpse), actor: ACTOR, sync: true });
    assert.equal(out.job.status, 'COMPLETED');
    assert.equal(out.cpse, cpse);
    const orgId = f.orgIds[cpse];
    const rows = f.db.prepare(`SELECT original_code FROM material_records WHERE organization_id = ?`).all(orgId) as unknown as Array<{ original_code: string }>;
    assert.equal(rows.length, 5, `${cpse} received exactly its 5 rows`);
    for (const r of rows) {
      assert.match(r.original_code, new RegExp(`^${cpse === 'NTPC' ? 'NT' : cpse === 'BHEL' ? 'BH' : cpse === 'NLC' ? 'NL' : cpse === 'SAIL' ? 'SL' : 'CP'}-`));
    }
  }
  // Cross-CPSE totals: 25 materials, 5 per org — nothing leaked between CPSEs.
  assert.equal(Number((f.db.prepare(`SELECT COUNT(*) AS n FROM material_records`).get() as unknown as { n: number }).n), 25);
  f.db.close();
});

/* ------------------------ 15: source traceability ------------------------- */

test('15. source traceability: CPSE → source system → source record → import → material → source_row', () => {
  const f = baseFixture();
  const out = executeIntegration({ adapterId: 'CPCL', fileName: 'CPCL-materials.csv', payload: feedOf('CPCL'), actor: ACTOR, sync: true });
  const mat = f.db.prepare(
    `SELECT mr.id, mr.original_code, mr.source_row, mr.import_id, o.code AS org_code, di.file_name
       FROM material_records mr JOIN organizations o ON o.id = mr.organization_id
       LEFT JOIN data_imports di ON di.id = mr.import_id
      WHERE mr.original_code = 'CP-9001'`,
  ).get() as unknown as { id: number; original_code: string; source_row: number; import_id: number; org_code: string; file_name: string };
  assert.equal(mat.org_code, 'CPCL');
  assert.equal(mat.import_id, out.importId);
  assert.equal(mat.source_row, 2, 'source file row 2 (after the header) recorded');
  assert.ok(mat.file_name.includes('CPCL'), 'source file recoverable from the import record');
  const run = getIntegrationRun(out.importId);
  assert.equal(run.adapterId, 'CPCL');
  assert.equal(run.adapterVersion, 'CPCL-MATERIAL-v1');
  assert.equal(run.cpse, 'CPCL');
  assert.equal(run.canonicalRecordCount, 5);
  f.db.close();
});

/* ------------------------- 16-17: format support -------------------------- */

test('16. CSV ingestion end-to-end through the EXISTING async import pipeline', () => {
  const f = baseFixture();
  const out = executeIntegration({ adapterId: 'NTPC', fileName: 'NTPC-materials.csv', payload: feedOf('NTPC'), actor: ACTOR, sync: true });
  assert.equal(out.job.status, 'COMPLETED');
  assert.equal(out.job.totalRows, 5);
  const imp = getImportRequired(out.importId);
  // Frozen Step-5 semantics: on the job path import_runs is the authoritative
  // ledger; data_imports keeps status='pending'/workflow_status='validating'
  // while its summary counters are advanced per committed chunk.
  assert.equal(imp.status, 'pending');
  assert.equal(imp.workflow_status, 'validating');
  assert.equal(imp.successful_rows, 5);
  f.db.close();
});

test('17. XLSX feed rides the SAME existing parsing engine (no second engine)', () => {
  const f = baseFixture();
  // Build an XLSX feed from the CPCL data (xlsx package already a dependency).
  const XLSX = require('xlsx') as typeof import('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['MAT_CODE', 'MAT_DESC', 'MAT_GROUP', 'MFR', 'PART_NO', 'MAT_GRADE', 'UOM'],
    ['CP-XLSX-1', 'SKF BALL BEARING 6205-2RS', 'BRG', 'SKF', '6205-2RS', 'EN31', 'NOS'],
    ['CP-XLSX-2', 'GATE VALVE 2IN 150# RF WCB', 'VLV', 'AUDCO', 'GV-2IN-150', 'WCB', 'NOS'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'FEED');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const a = analyzeIntegration({ adapterId: 'CPCL', fileName: 'CPCL-materials.xlsx', payload: buf as unknown as ArrayBuffer });
  assert.equal(a.sourceFormat, 'XLSX');
  assert.equal(a.rowsValid, 2, 'same adapter, same canonical output from the XLSX path');
  assert.equal(a.canonicalPreview[0].sourceRecordId, 'CP-XLSX-1');
  assert.equal(a.canonicalPreview[0].category, 'Bearings');
  f.db.close();
});

/* --------------------- 18-19: preview + quality report -------------------- */

test('18. preview + source quality report computed from ACTUAL data (no fabrication)', () => {
  const csv = [
    'MAT_CODE,MAT_DESC,MAT_GROUP,MFR,PART_NO,UOM',
    'CP-Q1,SKF BALL BEARING 6205-2RS,BRG,SKF,6205-2RS,NOS',
    'CP-Q2,GATE VALVE 2IN 150# RF WCB,VLV,AUDCO,GV-2IN-150,NOS',
    'CP-Q3,3PH INDUCTION MOTOR 5HP 415V,MOT,,,NOS',
  ].join('\n');
  const a = analyzeIntegration({ adapterId: 'CPCL', fileName: 'q.csv', payload: csv });
  const byField = new Map(a.fieldCoverage.map((c) => [c.field, c]));
  assert.equal(byField.get('materialCode')?.coveragePct, 100);
  assert.equal(byField.get('manufacturer')?.coveragePct, 66.7, '2 of 3 populated — computed, not invented');
  assert.equal(byField.get('partNumber')?.coveragePct, 66.7);
  assert.ok(a.canonicalPreview.length <= 50, 'preview bounded');
  assert.equal(a.canonicalPreview[0].sourceDescription, 'SKF BALL BEARING 6205-2RS');
});

test('19. validation summary counts are real and self-consistent', () => {
  const csv = 'MAT_CODE,MAT_DESC\nCP-G1,GOOD DESCRIPTION ONE\nCP-G2,GOOD DESCRIPTION TWO\n,MISSING CODE ROW\n';
  const a = analyzeIntegration({ adapterId: 'CPCL', fileName: 'g.csv', payload: csv });
  assert.equal(a.rowsReceived, 3);
  assert.equal(a.rowsValid, 2);
  assert.equal(a.rowsWithError, 1);
  assert.equal(a.rowsValid + a.rowsWithWarnings + a.rowsWithError, a.rowsReceived);
  assert.equal(a.canExecute, false);
});

/* ----------------------- 20: async job integration ------------------------ */

test('20. async job integration: existing import_runs model, chunk ledger, completion', () => {
  const f = baseFixture();
  const out = executeIntegration({ adapterId: 'SAIL', fileName: 'SAIL-materials.csv', payload: feedOf('SAIL'), actor: ACTOR, sync: true });
  const run = f.db.prepare(`SELECT id, status, total_rows, successful_rows, kind FROM import_runs WHERE id = ?`).get(out.jobId) as unknown as { id: string; status: string; total_rows: number; successful_rows: number; kind: string };
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.total_rows, 5);
  assert.equal(run.successful_rows, 5);
  assert.equal(run.kind, 'materials', 'existing job kinds unchanged');
  const chunks = f.db.prepare(`SELECT chunk_index, status FROM import_run_chunks WHERE run_id = ? ORDER BY chunk_index`).all(out.jobId) as unknown as Array<{ chunk_index: number; status: string }>;
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].status, 'COMMITTED');
  f.db.close();
});

/* --------------------------- 21: authorization ---------------------------- */

test('21. authorization: integration layer reuses the existing permission model', () => {
  const { roleHasPermission } = require('../src/lib/auth/permissions') as typeof import('../src/lib/auth/permissions');
  assert.equal(roleHasPermission('cpse_material_manager', 'IMPORT_MATERIALS'), true, 'managers may run integrations');
  assert.equal(roleHasPermission('cpse_technical_reviewer', 'IMPORT_MATERIALS'), false, 'reviewers may not import');
  assert.equal(roleHasPermission('authority', 'IMPORT_MATERIALS'), false, 'authority is read-only by design');
  assert.equal(roleHasPermission('platform_admin', 'IMPORT_MATERIALS'), true);
  // No new permission vocabulary was introduced (no duplicate permission system).
  const perms = require('../src/lib/auth/permissions') as typeof import('../src/lib/auth/permissions');
  assert.equal(perms.PERMISSIONS.includes('MANAGE_INTEGRATIONS' as never), false);
  assert.equal(perms.PERMISSIONS.includes('MANAGE_UOM_RULES'), true, 'Step 18 permission untouched');
});

/* ------------------------------ 22: audit --------------------------------- */

test('22. audit: integration mutations reuse the existing import vocabulary; reads stay silent', () => {
  const f = baseFixture();
  const before = countAudit();
  const a = analyzeIntegration({ adapterId: 'CPCL', fileName: 'CPCL-materials.csv', payload: feedOf('CPCL') });
  assert.equal(countAudit(), before, 'analyze (read-only) writes zero audit rows');
  assert.ok(a.rowsValid > 0);

  executeIntegration({ adapterId: 'CPCL', fileName: 'CPCL-materials.csv', payload: feedOf('CPCL'), actor: ACTOR, sync: true });
  const actions = (f.db.prepare(`SELECT action, details FROM audit_logs ORDER BY id`).all() as unknown as Array<{ action: string; details: string | null }>).map((r) => ({
    action: r.action,
    details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
  }));
  const created = actions.filter((x) => x.action === 'import_created');
  assert.equal(created.length, 2, 'existing import_created (job) + integration wrapper event');
  const integrationEvent = created.map((c) => c.details).find((d) => d?.integration === true);
  assert.ok(integrationEvent, 'integration context present');
  assert.equal(integrationEvent?.adapterId, 'CPCL');
  assert.equal(integrationEvent?.adapterVersion, 'CPCL-MATERIAL-v1');
  assert.equal(integrationEvent?.cpse, 'CPCL');
  assert.ok(actions.some((x) => x.action === 'import_started'), 'existing import_started reused');
  assert.ok(actions.some((x) => x.action === 'import_performed'), 'existing import_performed reused');
  // No per-field audit noise: total events remain small and lifecycle-scoped.
  assert.ok(actions.length <= 6, `expected lifecycle-scoped audit only, got ${actions.length}`);
  f.db.close();
});

/* ---------------------- 23: failed import safety -------------------------- */

test('23. failed import safety: a feed with errors imports NOTHING (fail-closed)', () => {
  const f = baseFixture();
  const bad = 'MAT_CODE,MAT_DESC\nCP-B1,GOOD DESCRIPTION ONE\n,BROKEN MISSING CODE\n';
  const before = Number((f.db.prepare(`SELECT COUNT(*) AS n FROM material_records`).get() as unknown as { n: number }).n);
  assert.throws(() => executeIntegration({ adapterId: 'CPCL', fileName: 'bad.csv', payload: bad, actor: ACTOR, sync: true }), /validation errors/i);
  const after = Number((f.db.prepare(`SELECT COUNT(*) AS n FROM material_records`).get() as unknown as { n: number }).n);
  assert.equal(after, before, 'material master untouched by the failed integration');
  assert.equal(Number((f.db.prepare(`SELECT COUNT(*) AS n FROM data_imports`).get() as unknown as { n: number }).n), 0, 'not even an import record was created');
  f.db.close();
});

/* ------------------- 24: existing material parity ------------------------- */

test('24. existing material parity: canonical imports behave like Import Center imports', () => {
  const f = baseFixture();
  executeIntegration({ adapterId: 'CPCL', fileName: 'CPCL-materials.csv', payload: feedOf('CPCL'), actor: ACTOR, sync: true });
  const mat = f.db.prepare(`SELECT * FROM material_records WHERE original_code = 'CP-9001'`).get() as unknown as {
    original_description: string;
    normalized_description: string | null;
    category: string;
    manufacturer: string | null;
    part_number: string | null;
    uom: string;
    processing_status: string;
    quality_status: string;
  };
  assert.equal(mat.original_description, 'SKF BALL BEARING 6205-2RS', 'original text never modified');
  assert.equal(mat.normalized_description, runPipeline({ originalDescription: 'SKF BALL BEARING 6205-2RS' }).normalizedDescription, 'same normalization engine');
  assert.equal(mat.category, 'Bearings');
  assert.equal(mat.manufacturer, 'SKF');
  assert.equal(mat.part_number, '6205-2RS');
  assert.equal(mat.quality_status, 'good');
  f.db.close();
});

/* ------------------------ 25: matching parity ----------------------------- */

test('25. matching parity: CP-1001↔NT-8821, CP-1001↔SL-7721, CP-1001↔BH-4410 all behave identically', () => {
  const f = baseFixture();
  // Seeded exactly like the demo database (pipeline + attributes).
  const cp = seedMaterial(f, 'CPCL', 'CP-1001');
  const nt = seedMaterial(f, 'NTPC', 'NT-8821');
  const sl = seedMaterial(f, 'SAIL', 'SL-7721');
  const bh = seedMaterial(f, 'BHEL', 'BH-4410');
  runMatching(ACTOR);
  const pair = (src: number, cand: number) =>
    (f.db.prepare(`SELECT final_score, match_type, critical_difference FROM match_candidates WHERE source_material_id = ? AND candidate_material_id = ?`).get(src, cand) ??
      f.db.prepare(`SELECT final_score, match_type, critical_difference FROM match_candidates WHERE source_material_id = ? AND candidate_material_id = ?`).get(cand, src)) as unknown as
      | { final_score: number; match_type: string; critical_difference: string | null }
      | undefined;
  const p1 = pair(cp, nt);
  const p2 = pair(cp, sl);
  const p3 = pair(cp, bh);
  assert.ok(p1, 'CP-1001 ↔ NT-8821 candidate generated');
  assert.ok(p2, 'CP-1001 ↔ SL-7721 candidate generated');
  assert.ok(p3, 'CP-1001 ↔ BH-4410 candidate generated');
  // Ground truth (data/evaluation/ground-truth-pairs.json): NT/SL are MATCHes;
  // BH is the seal-type (2RS vs ZZ) critical-conflict review case.
  assert.ok(p1.match_type !== 'different' && p1.final_score >= 70, `NT pair classified as a match (${p1.match_type}, ${p1.final_score})`);
  assert.ok(p2.match_type !== 'different' && p2.final_score >= 70, `SL pair classified as a match (${p2.match_type}, ${p2.final_score})`);
  assert.ok(
    (p3.critical_difference ?? '').toLowerCase().includes('seal') || ['needs_review', 'different'].includes(p3.match_type),
    `BH pair flagged for the seal conflict (${p3.match_type}, ${p3.critical_difference})`,
  );
  assert.ok(p1.final_score >= p3.final_score, '2RS pair scores at least as high as the 2RS-vs-ZZ pair');
  // Human decision flow unchanged: approve one pair.
  const matchId = (f.db.prepare(`SELECT id FROM match_candidates WHERE source_material_id = ? AND candidate_material_id = ?`).get(cp, nt) as unknown as { id: number }).id;
  const decided = decideMatch(matchId, { decision: 'approved', reviewer: 'reviewer22@demo', comment: 'parity fixture' }, 'reviewer22@demo');
  assert.equal(decided.status, 'approved');
  f.db.close();
});

/* --------------------- 26-30: Steps 17-21 regressions --------------------- */

const STEWARD = 'steward22@demo';
const APPROVER = 'approver22@demo';

interface GovFixture {
  db: DatabaseSync;
  cpclId: number;
  ntpcId: number;
  cmiId: number;
  cpclBearing: number;
  ntpcBearing: number;
  supplierA: number;
  supplierB: number;
}

function govFixture(): GovFixture {
  const f = baseFixture();
  const now = new Date().toISOString();
  const cpBrg = seedMaterial(f, 'CPCL', 'CP-1001');
  const ntBrg = seedMaterial(f, 'NTPC', 'NT-8821');
  void now;
  const pair = f.db.prepare(
    `INSERT INTO match_candidates
       (source_material_id, candidate_material_id, semantic_score, fuzzy_score, technical_score,
        category_compatible, final_score, match_type, explanation, status, created_at, updated_at)
     VALUES (?, ?, 90, 88, 95, 1, 91, 'identical', 'fixture', 'approved', ?, ?)`,
  ).run(cpBrg, ntBrg, now, now);
  f.db.prepare(
    `INSERT INTO match_decisions (match_id, decision, reviewer, comment, decided_at, created_at, updated_at)
     VALUES (?, 'approved', 'rev@demo', 'fixture approval', ?, ?, ?)`,
  ).run(Number(pair.lastInsertRowid), now, now, now);
  const cmi = f.db.prepare(`INSERT INTO common_materials (code, name, category, is_active, created_at, updated_at) VALUES ('CMI-T-BRG', 'Test bearing CMI', 'Bearings', 1, ?, ?)`).run(now, now);
  const cmiId = Number(cmi.lastInsertRowid);
  f.db.prepare(`INSERT INTO material_mappings (cmi_id, material_id, organization_id) VALUES (?, ?, ?)`).run(cmiId, cpBrg, f.orgIds.CPCL);
  f.db.prepare(`INSERT INTO material_mappings (cmi_id, material_id, organization_id) VALUES (?, ?, ?)`).run(cmiId, ntBrg, f.orgIds.NTPC);
  const supA = createSupplierRecord({ supplierCode: 'SUP-A', supplierName: 'Alpha Bearings Ltd', region: 'IN' }, STEWARD).id;
  const supB = createSupplierRecord({ supplierCode: 'SUP-B', supplierName: 'Beta Industrial Co', region: 'IN' }, STEWARD).id;
  return { db: f.db, cpclId: f.orgIds.CPCL, ntpcId: f.orgIds.NTPC, cmiId, cpclBearing: cpBrg, ntpcBearing: ntBrg, supplierA: supA, supplierB: supB };
}

function proc(g: GovFixture, orgId: number, materialId: number, supplierId: number, po: string, date: string, qty: string, uom: string): void {
  createProcurementRecord(
    { organizationId: orgId, materialId, cmiId: g.cmiId, supplierId, purchaseOrderReference: po, purchaseDate: date, quantity: qty, uom, status: 'DELIVERED' },
    STEWARD,
  );
}

function approvedRule(g: GovFixture, fromUom = 'SET', factor = 10): number {
  const id = createUomDomainRule({ cmiId: g.cmiId, fromUom, toUom: 'EA', factor, reason: 'Supplier pack sheet (fixture evidence).', actor: STEWARD }).id;
  transitionUomRuleLifecycle(id, 'approve', APPROVER);
  return id;
}

test('26. Step 17 regression: UOM registry + comparable quantity math unchanged', () => {
  const g = govFixture();
  assert.deepEqual(
    getUomRuleRegistry().filter((r) => r.isActive).map((r) => `${r.fromUom}>${r.toUom}x${r.factor}`).sort(),
    ['CM>MMx10', 'KG>Gx1000', 'L>MLx1000', 'M>MMx1000', 'NOS>EAx1', 'PCS>EAx1', 'TON>Gx1000000'],
  );
  proc(g, g.cpclId, g.cpclBearing, g.supplierA, 'PO-17A', '2026-01-05', '120', 'PCS');
  proc(g, g.ntpcId, g.ntpcBearing, g.supplierB, 'PO-17B', '2026-01-06', '180', 'NOS');
  proc(g, g.ntpcId, g.ntpcBearing, g.supplierB, 'PO-17C', '2026-01-07', '90', 'EA');
  assert.deepEqual(getCmiComparableDemand(g.cmiId)?.comparableQuantityByUom, { EA: '390' });
  g.db.close();
});

test('27. Step 18 regression: governed UOM rules + precedence + SoD unchanged', () => {
  const g = govFixture();
  proc(g, g.cpclId, g.cpclBearing, g.supplierA, 'PO-18A', '2026-01-08', '12', 'SET');
  const id = approvedRule(g);
  assert.equal(getEffectiveUomRule('SET', g.cmiId)?.ruleType, 'DOMAIN_SPECIFIC');
  assert.equal(getEffectiveUomRule('SET', null), null, 'global scope never sees a domain rule');
  // Separation of duties (same probe as the accepted Step-21 suite): the
  // proposer of an amendment cannot decide their own amendment.
  proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'SoD probe.', actor: STEWARD });
  assert.throws(() => decideUomRuleAmendment(id, 'approve', STEWARD), /Separation of duties/);
  g.db.close();
});

test('28. Step 19 regression: UOM rule history append-only and CREATE→APPROVE stamped', () => {
  const g = govFixture();
  const id = approvedRule(g);
  const h = getUomRuleHistory(id);
  assert.deepEqual(h.map((x) => x.action), ['CREATE', 'APPROVE']);
  assert.throws(() => g.db.prepare('UPDATE uom_rule_history SET actor = ?').run('evil'), /append-only/);
  assert.throws(() => g.db.prepare('DELETE FROM uom_rule_history').run(), /append-only/);
  g.db.close();
});

test('29. Step 20 regression: rule versions immutable + amendment lifecycle intact', () => {
  const g = govFixture();
  const id = approvedRule(g);
  proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'Corrected pack sheet.', actor: STEWARD });
  decideUomRuleAmendment(id, 'approve', APPROVER);
  const versions = getUomRuleVersions(id);
  assert.deepEqual(versions.map((v) => v.versionNumber), [1, 2]);
  assert.equal(versions[0].factor, 10, 'v1 content untouched');
  assert.throws(() => g.db.prepare('UPDATE uom_domain_rule_versions SET factor = 99').run(), /immutable/);
  assert.equal(normalizeQuantity('12', 'SET', g.cmiId).rule?.factor, 12, 'v2 effective after amendment');
  g.db.close();
});

test('30. Step 21 regression: governance cockpit aggregation unchanged on an integration-built fixture', () => {
  const g = govFixture();
  proc(g, g.cpclId, g.cpclBearing, g.supplierA, 'PO-21A', '2026-01-09', '12', 'SET');
  proc(g, g.cpclId, g.cpclBearing, g.supplierA, 'PO-21B', '2026-01-10', '4', 'bX9');
  const c = getGovernanceCockpit();
  assert.equal(c.summary.unconvertedRecords, 2);
  assert.equal(c.summary.unknownUomTokens, 1);
  assert.ok(c.workQueue.some((w) => w.type === 'UOM_REMEDIATION'));
  assert.ok(c.workQueue.some((w) => w.type === 'CMI_GOVERNANCE'));
  assert.ok(c.health.every((h) => ['PASS', 'WARNING', 'ACTION REQUIRED'].includes(h.state)));
  g.db.close();
});

/* --------------------- 31-32: identity + registry shape ------------------- */

test('31. description is NEVER the source identity (explicit non-goal §10)', () => {
  // Same description, different codes → different identities.
  const { canonical: c1 } = CPCL_ADAPTER.validateAndTransform({ MAT_CODE: 'CP-A1', MAT_DESC: 'SKF BALL BEARING 6205-2RS' }, 1);
  const { canonical: c2 } = CPCL_ADAPTER.validateAndTransform({ MAT_CODE: 'CP-B2', MAT_DESC: 'SKF BALL BEARING 6205-2RS' }, 2);
  assert.notEqual(sourceIdentityOf(c1!), sourceIdentityOf(c2!));
  // No UUID anywhere in the identity model.
  assert.ok(!sourceIdentityOf(c1!).match(/[0-9a-f]{8}-[0-9a-f]{4}/i));
  // Conflict detector: same prefix, different number → flagged; unrelated → not.
  assert.equal(codeConflictsWithDescription('CP-1001', 'SKF BEARING CP-9999'), true);
  assert.equal(codeConflictsWithDescription('CP-1001', 'NT-8821 BEARING'), false);
});

test('32. registry API shape exposes no secrets or infrastructure config', () => {
  const { describeAdapter } = require('../src/lib/integrations/registry') as typeof import('../src/lib/integrations/registry');
  for (const a of listAdapters()) {
    const view = describeAdapter(a) as unknown as Record<string, unknown>;
    const json = JSON.stringify(view).toLowerCase();
    for (const banned of ['password', 'secret', 'credential', 'conn', 'host', 'dsn']) {
      assert.equal(json.includes(banned), false, `registry view must not expose "${banned}"`);
    }
    assert.deepEqual(Object.keys(view).sort(), ['adapter', 'cpse', 'description', 'fieldMapping', 'id', 'label', 'sampleFile', 'status', 'supportedFormats', 'version'].sort());
  }
  // Vocabulary helpers behave deterministically.
  assert.equal(normalizeVocabularyValue({ BRG: 'Bearings' }, 'brg'), 'Bearings');
  assert.equal(normalizeVocabularyValue(undefined, 'X'), 'X');
  assert.equal(normalizeVocabularyValue({}, ''), null);
  void SAIL_ADAPTER;
  void NLC_ADAPTER;
});

console.log(`\nStep 22 (CPSE integration): ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(failures.map((x) => `  - ${x}`).join('\n'));
  process.exit(1);
}
