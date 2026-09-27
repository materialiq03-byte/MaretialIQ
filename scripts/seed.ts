/**
 * Idempotent synthetic demo seed. Safe to run repeatedly; skips when data
 * exists. Run via `npm run db:seed`. Every record goes through the real
 * pipeline (normalize → classify → extract → quality), so the demo data is
 * processed exactly like an uploaded file would be.
 */
import { getRawSqliteDb } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { runPipeline } from '../src/lib/pipeline';
import { hashPassword } from '../src/lib/auth/password';
import { SEED } from './seed-data';

const db = getRawSqliteDb();
migrate(db);

/**
 * Synthetic demo accounts. Passwords come from DEMO_PASSWORD (default
 * 'demo-password') — never hardcoded into application source. Clearly
 * labelled demo identities; not real government accounts.
 */
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password';

const DEMO_USERS: Array<{
  name: string;
  email: string;
  role: 'cpse_material_manager' | 'cpse_technical_reviewer' | 'authority' | 'platform_admin';
  org?: string;
}> = [
  { name: 'Raj Kumar', email: 'cpcl.manager@materialiq.demo', role: 'cpse_material_manager', org: 'CPCL' },
  { name: 'Priya Menon', email: 'cpcl.reviewer@materialiq.demo', role: 'cpse_technical_reviewer', org: 'CPCL' },
  { name: 'Amit Verma', email: 'ntpc.reviewer@materialiq.demo', role: 'cpse_technical_reviewer', org: 'NTPC' },
  { name: 'Deepa Iyer', email: 'authority@materialiq.demo', role: 'authority' },
  { name: 'System Administrator', email: 'admin@materialiq.demo', role: 'platform_admin' },
];

function seedDemoUsers(): void {
  const existing = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (existing > 0) return;
  const insert = db.prepare(
    `INSERT INTO users (name, email, password_hash, role, organization_id)
     VALUES (?, ?, ?, ?, (SELECT id FROM organizations WHERE code = ?))`
  );
  // Password hashes are identical for the shared demo password; compute once.
  return void (async () => {
    const hash = await hashPassword(DEMO_PASSWORD);
    for (const u of DEMO_USERS) {
      insert.run(u.name, u.email, hash, u.role, u.org ?? null);
    }
    console.log(
      `Seeded ${DEMO_USERS.length} demo accounts (password from DEMO_PASSWORD env, default 'demo-password').`
    );
  })();
}

function seed(): void {
  const existing = (db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number }).n;
  if (existing > 0) {
    seedDemoUsers();
    console.log('Database already seeded — skipping (delete data/materialiq.db* to reseed).');
    return;
  }

  const materialIds = new Map<string, number>();

  for (const org of SEED) {
    const orgRes = db
      .prepare(`INSERT INTO organizations (code, name) VALUES (?, ?)`)
      .run(org.code, org.name);
    const orgId = Number(orgRes.lastInsertRowid);

    const importRes = db
      .prepare(
        `INSERT INTO data_imports (organization_id, file_name, file_type, total_rows, status, successful_rows)
         VALUES (?, ?, 'csv', ?, 'completed', ?)`
      )
      .run(orgId, org.code.toLowerCase() + '-catalogue-demo.csv', org.materials.length, org.materials.length);
    const importId = Number(importRes.lastInsertRowid);

    for (const m of org.materials) {
      // The real pipeline — same code path an uploaded CSV row takes.
      const output = runPipeline({ originalDescription: m.description, categoryOverride: m.category });

      const matRes = db
        .prepare(
          `INSERT INTO material_records
             (organization_id, original_code, original_description, normalized_description,
              category, subcategory, manufacturer, model, part_number, material_type, uom, import_id,
              processing_status, classification_confidence, classification_source, quality_status, quality_checks)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          orgId,
          m.code,
          m.description,
          output.normalizedDescription,
          output.classification.category ?? m.category,
          output.classification.subcategory ?? m.subcategory ?? null,
          m.manufacturer ?? null,
          m.model ?? null,
          null,
          m.materialType ?? null,
          m.uom ?? 'NOS',
          importId,
          output.processingStatus,
          output.classification.confidence,
          output.classification.source,
          output.quality.status,
          JSON.stringify(output.quality.checks)
        );
      const materialId = Number(matRes.lastInsertRowid);
      materialIds.set(`${org.code}:${m.code}`, materialId);

      for (const a of output.attributes) {
        db.prepare(
          `INSERT INTO material_attributes
             (material_id, attribute_name, value, normalized_value, unit, is_critical, extraction_method, confidence)
           VALUES (?, ?, ?, ?, ?, ?, 'rule', ?)`
        ).run(
          materialId,
          a.attributeName,
          a.value,
          a.normalizedValue,
          a.unit,
          a.isCritical ? 1 : 0,
          a.confidence
        );
      }
    }
  }

  // ---- Pre-approved pair demonstrating the full CMI + mapping chain ----
  const cpcl = materialIds.get('CPCL:CP-1001')!;
  const ntpc = materialIds.get('NTPC:NT-8821')!;
  const sail = materialIds.get('SAIL:SL-7721')!;

  const matchRes = db
    .prepare(
      `INSERT INTO match_candidates
         (source_material_id, candidate_material_id, semantic_score, fuzzy_score, technical_score,
          category_compatible, final_score, match_type, explanation, status)
       VALUES (?, ?, 100, 92, 100, 1, 96, 'identical', ?, 'approved')`
    )
    .run(
      cpcl,
      ntpc,
      'Pre-approved synthetic pair: identical specifications (bore 25 mm, outer 52 mm, width 15 mm, seal 2RS, deep groove ball).'
    );
  const matchId = Number(matchRes.lastInsertRowid);

  db.prepare(
    `INSERT INTO match_decisions (match_id, decision, reviewer, comment)
     VALUES (?, 'approved', 'Demo seed', 'Identical SKF 6205-2RS specifications verified across CPCL and NTPC records.')`
  ).run(matchId);

  const cmiRes = db
    .prepare(
      `INSERT INTO common_materials (code, name, description, category, source_match_id)
       VALUES ('CMI-BRG-6205', 'Ball bearing 6205-2RS, deep groove, SKF',
               'Common identity for the 6205-2RS deep groove ball bearing family (synthetic demo).',
               'Bearings', ?)`
    )
    .run(matchId);
  const cmiId = Number(cmiRes.lastInsertRowid);

  const mapStmt = db.prepare(
    `INSERT INTO material_mappings (cmi_id, material_id, organization_id)
     VALUES (?, ?, (SELECT organization_id FROM material_records WHERE id = ?))`
  );
  mapStmt.run(cmiId, cpcl, cpcl);
  mapStmt.run(cmiId, ntpc, ntpc);
  mapStmt.run(cmiId, sail, sail);

  db.prepare(
    `INSERT INTO audit_logs (action, entity_type, entity_id, actor, details)
     VALUES ('mapping_created', 'common_material', ?, 'Demo seed', ?)`
  ).run(cmiId, JSON.stringify({ members: ['CP-1001', 'NT-8821', 'SL-7721'] }));

  // ---- Initial deterministic match run ----
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runMatching } = require('../src/lib/services/matching-service') as typeof import('../src/lib/services/matching-service');
  const summary = runMatching('Demo seed');
  seedDemoUsers();
  console.log(
    `Seeded ${SEED.length} CPSEs / ${materialIds.size} materials (pipeline-processed). ` +
      `Match run: ${summary.pairsCompared} pairs compared, ${summary.candidatesCreated} candidates, ` +
      `${summary.reviewItemsCreated} review items.`
  );
}

seed();
