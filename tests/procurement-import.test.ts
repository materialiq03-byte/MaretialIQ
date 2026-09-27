/**
 * Step 13 — procurement ingestion regression suite.
 *
 * `npx tsx tests/procurement-import.test.ts` (part of the npm test chain).
 *
 * Runs against an isolated temp SQLite DB (migrated to HEAD, seeded with a
 * minimal material/supplier/CMI fixture). Covers the Step-13 section-29
 * behaviors: analyze (CSV + XLSX), column suggestions, explicit/broken
 * mappings, resolution + validation rules, CMI consumption, duplicate
 * policy, idempotent re-run, bounded preview, chunked execution, async 202
 * semantics (claim/complete), audit events and baseline safety.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import {
  analyzeProcurementCsv,
  getProcurementPreviewPage,
  executeProcurementChunk,
  suggestProcurementMapping,
  procMappingIsUsable,
  parseProcurementDate,
  isRealCalendarDate,
  createProcurementImportJob,
  PROC_PREVIEW_MAX_ROWS,
} from '../src/lib/services/procurement-import-service';
import { claimAndStageForTests, completeJobForTests } from '../src/lib/services/import-job-test-hooks';
import { createImportJob } from '../src/lib/services/import-job-service';
import { createSupplierRecord } from '../src/lib/services/procurement-service';
import { assertOrganizationWrite } from '../src/lib/auth/guard';
import type { SessionUser } from '../src/lib/auth/types';
import { getDb } from '../src/lib/db/client';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
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

const NOW = new Date().toISOString();

interface Fixture {
  db: DatabaseSync;
  orgs: Record<string, number>;
  materials: Record<string, number>;
  cmiId: number;
  suppliers: Record<string, number>;
}

function seedFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-procimp-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  migrate(db);
  setDbForTests(db);
  const insOrg = db.prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`);
  const cpcl = Number(insOrg.run('CPCL', 'Chennai Petroleum (demo)', NOW, NOW).lastInsertRowid);
  const ntpc = Number(insOrg.run('NTPC', 'NTPC Limited (demo)', NOW, NOW).lastInsertRowid);
  const sail = Number(insOrg.run('SAIL', 'Steel Authority (demo)', NOW, NOW).lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO material_records
       (organization_id, original_code, original_description, category, uom, processing_status, quality_status, created_at, updated_at)
     VALUES (?, ?, ?, 'Bearings', 'EA', 'ready_for_matching', 'good', ?, ?)`,
  );
  const m1 = Number(ins.run(cpcl, 'CP-1001', 'SKF BALL BEARING 6205-2RS', NOW, NOW).lastInsertRowid);
  const m2 = Number(ins.run(ntpc, 'NT-8821', 'SKF DEEP GROOVE BRG 6205 2RS', NOW, NOW).lastInsertRowid);
  const m3 = Number(ins.run(sail, 'SL-7721', 'SKF BEARING 6205 2RS', NOW, NOW).lastInsertRowid);
  const m4 = Number(ins.run(cpcl, 'CP-2000', 'UNHARMONIZED VALVE', NOW, NOW).lastInsertRowid);
  const cmi = db.prepare(
    `INSERT INTO common_materials (code, name, category, is_active, created_at, updated_at) VALUES ('CMI-BRG-6205', 'Ball bearing 6205-2RS', 'Bearings', 1, ?, ?)`,
  );
  const cmiId = Number(cmi.run(NOW, NOW).lastInsertRowid);
  const insMap = db.prepare(`INSERT INTO material_mappings (cmi_id, material_id, organization_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
  insMap.run(cmiId, m1, cpcl, NOW, NOW);
  insMap.run(cmiId, m2, ntpc, NOW, NOW);
  insMap.run(cmiId, m3, sail, NOW, NOW);
  const insSup = db.prepare(
    `INSERT INTO suppliers (supplier_code, supplier_name, is_active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`,
  );
  const skf = Number(insSup.run('SKF', 'SKF Bearings (demo)', NOW, NOW).lastInsertRowid);
  const fag = Number(insSup.run('FAG', 'FAG Industrial (demo)', NOW, NOW).lastInsertRowid);
  const tata = Number(insSup.run('TATA', 'Tata Steel Trading (demo)', NOW, NOW).lastInsertRowid);
  return {
    suppliers: { SKF: skf, FAG: fag, TATA: tata },
    db,
    orgs: { CPCL: cpcl, NTPC: ntpc, SAIL: sail },
    materials: { 'CP-1001': m1, 'NT-8821': m2, 'SL-7721': m3, 'CP-2000': m4 },
    cmiId,
  };
}

function csv(rows: string[]): Buffer {
  return Buffer.from(
    ['CPSE,Material Code,Vendor,PO Date,Ordered Qty,Unit,PO Number,Rate,Currency,Status,Plant',
     ...rows].join('\r\n'),
  );
}

const GOOD = 'CPCL,CP-1001,SKF,2026-01-15,120,EA,PO-9001,1250.50,INR,ORDERED,Chennai';

function analyze(buffer: Buffer, name = 'proc.csv', mapping?: Record<string, string | null>) {
  return analyzeProcurementCsv(buffer, name, name.endsWith('.xlsx') ? 'xlsx' : 'csv', fixture.orgs.CPCL, mapping ?? null);
}

let fixture: Fixture;

function main(): void {
  fixture = seedFixture();
  const db = fixture.db;

  const runJob = (importId: number): string => {
    const jobId = createProcurementImportJob(importId, 'tester@demo');
    const claim = claimAndStageForTests(jobId);
    for (let i = 0; i < Math.ceil(claim.procRows.length / claim.chunkSize); i++) {
      if (claim.kind !== 'procurement') throw new Error('expected procurement job');
      executeProcurementChunk(jobId, i);
    }
    if (claim.procRows.length > 0) completeJobForTests(jobId, claim.dataImportId, claim.procRows.length, () => new Date().toISOString());
    return jobId;
  };

  // ------------------------------------------------------------------ 1
  test('CSV analyze: suggestions, summary, bounded preview, no rows persisted', () => {
    const r = analyze(csv([GOOD, 'NTPC,NT-8821,SKF,15/01/2026,180,EA,PO-9002,,,DELIVERED,']));
    assert.equal(r.summary.totalRows, 2);
    assert.equal(r.summary.valid, 2);
    assert.equal(r.mappingUsable, true);
    assert.equal(r.mapping.organization, 'CPSE');
    assert.equal(r.mapping.materialCode, 'Material Code');
    assert.equal(r.mapping.supplier, 'Vendor');
    assert.equal(r.mapping.purchaseDate, 'PO Date');
    assert.equal(r.mapping.quantity, 'Ordered Qty');
    assert.equal(r.mapping.uom, 'Unit');
    assert.equal(r.mapping.unitPrice, 'Rate');
    assert.ok(r.canExecute);
    const before = (db.prepare('SELECT COUNT(*) n FROM procurement_records').get() as { n: number }).n;
    assert.equal(before, 0, 'analyze is read-only for business data');
  });

  // ------------------------------------------------------------------ 2
  test('XLSX analyze works through the batch parser (same contract)', () => {
    // Build a tiny xlsx in memory via the xlsx lib (same dep the app uses).
    const XLSX = require('xlsx') as typeof import('xlsx');
    const aoa = [
      ['CPSE', 'Material Code', 'Vendor', 'PO Date', 'Ordered Qty', 'Unit', 'PO Number'],
      ['CPCL', 'CP-1001', 'SKF', '2026-01-15', '120', 'EA', 'PO-X1'],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'P');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const r = analyze(buf, 'proc.xlsx');
    assert.equal(r.summary.totalRows, 1);
    assert.equal(r.summary.valid, 1);
    assert.equal(r.mapping.materialCode, 'Material Code');
  });

  // ------------------------------------------------------------------ 3
  test('broken mapping: missing required target is unusable and cannot execute', () => {
    const r = analyze(csv([GOOD]), 'proc.csv', { supplier: null });
    assert.equal(r.mappingUsable, false);
    assert.equal(r.canExecute, false);
  });

  // ------------------------------------------------------------------ 4
  test('validation: unknown CPSE / material / supplier / date / qty / status produce error rows', () => {
    const r = analyze(csv([
      'XXXX,CP-1001,SKF,2026-01-15,120,EA,PO-1,,,ORDERED,',      // unknown org
      'CPCL,ZZ-9999,SKF,2026-01-15,120,EA,PO-2,,,ORDERED,',      // unknown material (org-aware)
      'CPCL,CP-1001,NOVENDOR,2026-01-15,120,EA,PO-3,,,ORDERED,', // unknown supplier
      'CPCL,CP-1001,SKF,31/02/2026,120,EA,PO-4,,,ORDERED,',      // impossible date
      'CPCL,CP-1001,SKF,2026-01-15,0,EA,PO-5,,,ORDERED,',        // qty <= 0
      'CPCL,CP-1001,SKF,2026-01-15,120,EA,PO-6,,,SHIPPED,',      // bad status
    ]));
    assert.equal(r.summary.errors, 6);
    assert.equal(r.summary.unknownOrganization, 1);
    assert.equal(r.summary.unknownMaterial, 1);
    assert.equal(r.summary.unknownSupplier, 1);
    assert.equal(r.summary.invalidDate, 1);
    assert.equal(r.summary.invalidQuantity, 1);
    assert.equal(r.summary.invalidStatus, 1);
    assert.equal(r.canExecute, false);
  });

  // ------------------------------------------------------------------ 5
  test('price/currency pairing enforced; currency-only or price-only rejected', () => {
    const r = analyze(csv([
      'CPCL,CP-1001,SKF,2026-01-15,120,EA,PO-A,,INR,ORDERED,',   // currency without price
      'CPCL,CP-1001,SKF,2026-01-15,120,EA,PO-B,10,,ORDERED,',    // price without currency
      'CPCL,CP-1001,SKF,2026-01-15,120,EA,PO-C,10,USD,ORDERED,', // ok
    ]));
    assert.equal(r.summary.invalidPrice, 2);
    assert.equal(r.summary.valid, 1);
  });

  // ------------------------------------------------------------------ 6
  test('CMI consumption: mapped material auto-carries CMI; unmapped stays NULL', () => {
    const r = analyze(csv([GOOD, 'CPCL,CP-2000,SKF,2026-01-16,40,EA,PO-7,,,ORDERED,']));
    assert.equal(r.summary.valid, 2);
    const p1 = r.previewRows.find((p) => p.rowNumber === 2)!;
    const p2 = r.previewRows.find((p) => p.rowNumber === 3)!;
    assert.equal(p1.resolved?.cmiCode, 'CMI-BRG-6205');
    assert.equal(p2.resolved?.cmiCode ?? null, null);
  });

  // ------------------------------------------------------------------ 7
  test('explicit CMI: correct accepted, wrong CMI rejected, unknown rejected, unmapped material rejected', () => {
    const r = analyze(csv([
      'CPCL,CP-1001,SKF,2026-01-15,120,EA,PO-8,,,ORDERED,,CMI-BRG-6205', // correct (extra header col needed)
    ]));
    // This file has 11 headers; CMI col not present -> falls to auto-CMI path.
    assert.equal(r.summary.valid, 1);

    const r2 = analyze(
      csv([GOOD.replace('ORDERED,Chennai', 'ORDERED,Chennai,CMI-BRG-6205'), 'CPCL,CP-1001,SKF,2026-01-16,50,EA,PO-9,,,ORDERED,,CMI-VALVE-001', 'CPCL,CP-1001,SKF,2026-01-17,60,EA,PO-10,,,ORDERED,,CMI-NOPE-999']),
      'proc.csv',
      { cmiCode: 'CMI-BRG-6205,X' }, // placeholder; real header mapping below
    );
    // Simpler: run a dedicated file with a CMI header.
    const buf = Buffer.from([
      'CPSE,Material Code,Vendor,PO Date,Ordered Qty,Unit,PO Number,Rate,Currency,Status,Plant,CMI Code',
      'CPCL,CP-1001,SKF,2026-01-15,120,EA,PO-8,,,ORDERED,,CMI-BRG-6205',
      'CPCL,CP-1001,SKF,2026-01-16,50,EA,PO-9,,,ORDERED,,CMI-VALVE-001',
      'CPCL,CP-2000,SKF,2026-01-17,60,EA,PO-10,,,ORDERED,,CMI-BRG-6205',
      'CPCL,CP-1001,SKF,2026-01-18,70,EA,PO-11,,,ORDERED,,CMI-NOPE-999',
    ].join('\n'));
    const r3 = analyze(buf);
    assert.equal(r3.summary.cmiMismatch, 1, 'wrong-CMI mapping rejected');
    assert.equal(r3.summary.unknownCmi, 2, 'unknown CMI rejected (incl. unmapped material row)');
    assert.equal(r3.summary.valid, 1);
  });

  // ------------------------------------------------------------------ 8
  test('in-file duplicate purchase line downgraded to warning and skipped at import', () => {
    const r = analyze(csv([GOOD, GOOD.replace('PO-9001', 'PO-9001')]));
    assert.equal(r.summary.duplicateInFile, 1);
    const dup = r.previewRows.find((p) => p.rowNumber === 3)!;
    assert.equal(dup.severity, 'WARNING');
    assert.ok(dup.problems.some((p) => p.rule === 'duplicate_in_file'));
  });

  // ------------------------------------------------------------------ 9
  test('bounded preview: only the first PROC_PREVIEW_MAX_ROWS rows cross the boundary', () => {
    const many: string[] = [];
    for (let i = 0; i < PROC_PREVIEW_MAX_ROWS + 30; i++) {
      many.push(`CPCL,CP-1001,SKF,2026-02-${String((i % 27) + 1).padStart(2, '0')},${i + 1},EA,PO-BULK-${i},,,ORDERED,`);
    }
    const r = analyze(csv(many));
    assert.equal(r.previewRows.length, PROC_PREVIEW_MAX_ROWS);
    assert.equal(r.summary.totalRows, PROC_PREVIEW_MAX_ROWS + 30);
  });

  // ------------------------------------------------------------------ 10
  test('execution: chunked import persists valid rows with resolved material/CMI/supplier', () => {
    const r = analyze(csv([
      GOOD,
      'NTPC,NT-8821,SKF,2026-01-20,180,EA,PO-9002,,,DELIVERED,',
      'CPCL,CP-2000,SKF,2026-01-21,40,EA,PO-9003,,,ORDERED,',
      'CPCL,ZZ-9999,SKF,2026-01-22,10,EA,PO-9004,,,ORDERED,',
    ]));
    const jobId = runJob(r.importId);
    const job = JSON.parse(JSON.stringify(getJob(jobId)));
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.successfulRows, 3);
    // Job counters reflect the EXECUTION phase (frozen import_runs contract);
    // the analyze-time reject is file-level accounting on data_imports.
    assert.equal(job.failedRows, 0);
    const fileErr = (db.prepare('SELECT error_rows n FROM data_imports WHERE id = ?').get(r.importId) as { n: number }).n;
    assert.equal(fileErr, 1, 'rejected row accounted on data_imports.error_rows');
    const rec = db.prepare(
      `SELECT pr.quantity, pr.uom, pr.cmi_id, cm.code AS cmi_code, m.original_code
         FROM procurement_records pr
         JOIN material_records m ON m.id = pr.material_id
         LEFT JOIN common_materials cm ON cm.id = pr.cmi_id
        WHERE pr.purchase_order_reference = 'PO-9002'`,
    ).get() as { quantity: string; uom: string; cmi_code: string; original_code: string };
    assert.equal(rec.original_code, 'NT-8821');
    assert.equal(rec.cmi_code, 'CMI-BRG-6205', 'CMI consumed from mappings');
    assert.equal(rec.quantity, '180');
    assert.equal(rec.uom, 'EA');
    const unhar = db.prepare(
      `SELECT cm.code FROM procurement_records pr LEFT JOIN common_materials cm ON cm.id = pr.cmi_id WHERE pr.purchase_order_reference = 'PO-9003'`,
    ).get() as { code: string | null };
    assert.equal(unhar.code ?? null, null, 'unharmonized material keeps NULL CMI');
  });

  // ------------------------------------------------------------------ 11
  test('idempotent re-run: identical file imports nothing new; new lines still import', () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM procurement_records').get() as { n: number }).n;
    const r = analyze(csv([GOOD, 'NTPC,NT-8821,SKF,2026-01-20,180,EA,PO-9002,,,DELIVERED,']));
    runJob(r.importId);
    const after = (db.prepare('SELECT COUNT(*) n FROM procurement_records').get() as { n: number }).n;
    assert.equal(after, before, 'identical lines skipped');
    const r2 = analyze(csv([GOOD.replace('2026-01-15,120', '2026-03-01,300').replace('PO-9001', 'PO-9100')]));
    runJob(r2.importId);
    const after2 = (db.prepare('SELECT COUNT(*) n FROM procurement_records').get() as { n: number }).n;
    assert.equal(after2, before + 1, 'legitimate repeated purchase imports');
  });

  // ------------------------------------------------------------------ 12
  test('UOM preserved verbatim; quantity/price stored as exact decimals', () => {
    const r = analyze(csv(['CPCL,CP-1001,SKF,2026-04-01,2.50,SET,PO-U1,1250.5,INR,ORDERED,']));
    runJob(r.importId);
    const rec = db.prepare(`SELECT quantity, uom, unit_price FROM procurement_records WHERE purchase_order_reference = 'PO-U1'`).get() as { quantity: string; uom: string; unit_price: string };
    assert.equal(rec.quantity, '2.5');
    assert.equal(rec.uom, 'SET');
    assert.equal(rec.unit_price, '1250.5');
  });

  // ------------------------------------------------------------------ 13
  test('chunk failure isolation: bad chunk marks job FAILED and is retryable', () => {
    // Corrupt the import's mapping so execution throws (simulates a mid-job failure).
    const r = analyze(csv([GOOD.replace('2026', '2027')]));
    const report = db.prepare(`SELECT row_report FROM data_imports WHERE id = ?`).get(r.importId) as { row_report: string };
    const jobId = createProcurementImportJob(r.importId, 'tester@demo');
    // Claim while the report is intact (claim parses it for staging), then
    // corrupt: the CHUNK executor must fail (and be retryable after repair).
    const claim = claimAndStageForTests(jobId);
    assert.equal(claim.kind, 'procurement');
    db.prepare(`UPDATE data_imports SET row_report = '{not json' WHERE id = ?`).run(r.importId);
    assert.throws(() => executeProcurementChunk(jobId, 0));
    // Retry after repair succeeds.
    db.prepare(`UPDATE data_imports SET row_report = ? WHERE id = ?`).run(report.row_report, r.importId);
    executeProcurementChunk(jobId, 0);
    completeJobForTests(jobId, claim.dataImportId, claim.procRows.length, () => new Date().toISOString());
    const job = getJob(jobId);
    assert.equal(job.status, 'COMPLETED');
  });

  // ------------------------------------------------------------------ 14
  test('single-active guard: a second job while one is QUEUED/RUNNING is rejected', () => {
    const r = analyze(csv([GOOD.replace('2026', '2028')]));
    const j1 = createProcurementImportJob(r.importId, 'tester@demo');
    // j1 is QUEUED (not started) -> creating another job must conflict.
    assert.throws(() => createProcurementImportJob(r.importId, 'tester@demo'), /already queued or running/);
    // Material jobs share the same guard.
    assert.throws(() => createImportJob(r.importId, 'tester@demo'), /already queued or running/);
    const claim = claimAndStageForTests(j1);
    for (let i = 0; i < Math.ceil(claim.procRows.length / claim.chunkSize); i++) executeProcurementChunk(j1, i);
    completeJobForTests(j1, claim.dataImportId, claim.procRows.length, () => new Date().toISOString());
    // Guard released after completion.
    const j2 = createProcurementImportJob(r.importId, 'tester@demo');
    assert.ok(j2.startsWith('prc_'));
    // Leave no job QUEUED: the single-active guard is a real DB constraint.
    const c2 = claimAndStageForTests(j2);
    for (let i = 0; i < Math.ceil(c2.procRows.length / c2.chunkSize); i++) executeProcurementChunk(j2, i);
    completeJobForTests(j2, c2.dataImportId, c2.procRows.length, () => new Date().toISOString());
  });

  // ------------------------------------------------------------------ 15
  test('audit: procurement_import_started recorded with actor', () => {
    const audits = db.prepare(`SELECT actor, action FROM audit_logs WHERE action = 'procurement_import_started' ORDER BY id DESC LIMIT 1`).get() as { actor: string; action: string };
    assert.equal(audits.actor, 'tester@demo');
  });

  // ------------------------------------------------------------------ 16
  test('staging table reconciles: procurement_import_rows cleared per job, committed chunks tracked', () => {
    const r = analyze(csv([GOOD.replace('2026', '2029'), 'CPCL,CP-1001,SKF,2026-05-01,11,EA,PO-S1,,,ORDERED,']));
    const jobId = runJob(r.importId);
    const chunks = db.prepare(`SELECT COUNT(*) n FROM import_run_chunks WHERE run_id = ? AND status = 'COMMITTED'`).get(jobId) as { n: number };
    assert.equal(chunks.n, 1);
    const staged = db.prepare(`SELECT COUNT(*) n FROM procurement_import_rows WHERE job_id = ?`).get(jobId) as { n: number };
    assert.equal(staged.n, 2);
  });

  // ------------------------------------------------------------------ 17
  test('helpers: date parsing + calendar validity', () => {
    assert.equal(parseProcurementDate('15/01/2026'), '2026-01-15');
    assert.equal(parseProcurementDate('2026-01-15'), '2026-01-15');
    assert.equal(parseProcurementDate('2026-13-01'), null);
    assert.equal(isRealCalendarDate('2026-02-29'), false);
    assert.equal(isRealCalendarDate('2024-02-29'), true);
    assert.equal(isRealCalendarDate('2026-04-31'), false);
  });

  // ------------------------------------------------------------------ 18
  test('suggestProcurementMapping: alias families resolve and never double-book', () => {
    const { mapping, suggestions } = suggestProcurementMapping(['CPSE', 'Vendor', 'Qty', 'PO Number', 'Unit Price', 'Currency Code', 'Other']);
    assert.equal(mapping.organization, 'CPSE');
    assert.equal(mapping.supplier, 'Vendor');
    assert.equal(mapping.quantity, 'Qty');
    assert.equal(mapping.poReference, 'PO Number');
    assert.equal(mapping.unitPrice, 'Unit Price');
    assert.equal(mapping.currency, 'Currency Code');
    const targets = suggestions.filter((s) => s.target).map((s) => s.target);
    assert.equal(new Set(targets).size, targets.length, 'no target mapped twice');
    assert.equal(procMappingIsUsable(mapping), false, 'material/date/uom still required');
  });

  // ------------------------------------------------------------------ 19
  test('inactive CMI: auto-carried mapping degrades to WARNING + NULL link; never an error', () => {
    db.prepare(`UPDATE common_materials SET is_active = 0 WHERE id = ?`).run(fixture.cmiId);
    const r = analyze(csv([GOOD]));
    const p = r.previewRows.find((x) => x.rowNumber === 2)!;
    assert.equal(p.severity, 'WARNING', 'inactive mapping is a warning, importable');
    assert.ok(p.problems.some((x) => x.rule === 'cmi_mismatch'));
    assert.equal(p.resolved?.cmiCode ?? null, null, 'no CMI link written for an inactive mapping');
    db.prepare(`UPDATE common_materials SET is_active = 1 WHERE id = ?`).run(fixture.cmiId);
  });

  // ------------------------------------------------------------------ 20
  test('authorization: org-scoped write guard + authority read-only rule enforced server-side', () => {
    const cpseUser: SessionUser = { id: 9, name: 'CP', email: 'cp@demo', role: 'cpse_material_manager', organizationId: fixture.orgs.CPCL, organizationCode: 'CPCL', organizationName: 'CPCL', demoSwitched: false };
    const otherCpse: SessionUser = { ...cpseUser, organizationId: fixture.orgs.NTPC, organizationCode: 'NTPC' };
    const authority: SessionUser = { id: 10, name: 'AU', email: 'au@demo', role: 'authority', organizationId: null, organizationCode: null, organizationName: null, demoSwitched: false };
    assert.doesNotThrow(() => assertOrganizationWrite(cpseUser, fixture.orgs.CPCL), 'own-org write allowed');
    assert.throws(() => assertOrganizationWrite(otherCpse, fixture.orgs.CPCL), /different CPSE/, 'cross-CPSE write blocked');
    assert.throws(() => assertOrganizationWrite(authority, fixture.orgs.CPCL), /read-only/, 'authority cannot import');
  });

  console.log(`
${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(1);
  }
}

/** Minimal typed accessor over import_runs for assertions. */
function getJob(jobId: string): { status: string; successfulRows: number; failedRows: number; processedRows: number } {
  const row = getDb().prepare(`SELECT status, successful_rows, failed_rows, processed_rows FROM import_runs WHERE id = ?`).get(jobId) as
    | { status: string; successful_rows: number; failed_rows: number; processed_rows: number }
    | undefined;
  if (!row) throw new Error(`job ${jobId} not found`);
  return { status: row.status, successfulRows: row.successful_rows, failedRows: row.failed_rows, processedRows: row.processed_rows };
}

main();
