/**
 * Diagnostic: which labelled pairs disagree with the engine, and why.
 * Run: npx tsx scripts/diag-eval.ts   (uses a disposable temp DB)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { analyzeImport, executeImport } from '../src/lib/services/import-center-service';
import { runMatching } from '../src/lib/services/matching-service';
import { listAllMaterialsForMatching } from '../src/lib/db/repositories/matching-queries';
import { scorePair } from '../src/lib/matching/engine';
import { SAME_ITEM_GROUPS, CONFLICT_PAIRS } from '../src/lib/matching/evaluation';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-diag-'));
const db = new DatabaseSync(path.join(tmpDir, 'diag.db'));
setDbForTests(db);
migrate(db);

const now = new Date().toISOString();
const ids = new Map<string, number>();
for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
  const r = db.prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`).run(code, `${code} demo`, now, now);
  ids.set(code, Number(r.lastInsertRowid));
}

const CSV_DIR = path.join(process.cwd(), 'data', 'synthetic-imports');
for (const [org, file] of [['CPCL', 'CPCL.csv'], ['NTPC', 'NTPC.csv'], ['BHEL', 'BHEL.csv'], ['NLC', 'NLC.csv'], ['SAIL', 'SAIL.csv']] as const) {
  const parsed = analyzeImport({ organizationId: ids.get(org)!, fileName: file, fileType: 'csv', payload: fs.readFileSync(path.join(CSV_DIR, file), 'utf8') });
  executeImport({ importId: parsed.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'diag' });
}
runMatching('diag');

const materials = listAllMaterialsForMatching();
const byKey = new Map(materials.map((m) => [`${m.orgCode}|${m.originalCode}`, m]));

console.log('--- FALSE NEGATIVES (labelled same item, engine did not auto-match) ---');
for (const group of SAME_ITEM_GROUPS) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = byKey.get(group[i]);
      const b = byKey.get(group[j]);
      if (!a || !b) { console.log('MISSING', group[i], group[j]); continue; }
      const s = scorePair(a, b);
      if (s.decision !== 'HIGH_CONFIDENCE_MATCH') {
        console.log(`FN ${group[i]} vs ${group[j]} → ${s.decision} score=${s.finalScore} fuzzy=${s.fuzzyScore.toFixed(0)} tech=${s.technicalScore.toFixed(0)} sem=${s.semanticScore.toFixed(0)}`);
        console.log(`   A: "${a.originalDescription}"  B: "${b.originalDescription}"`);
        console.log(`   Anorm: "${a.normalizedDescription}"  Bnorm: "${b.normalizedDescription}"`);
      }
    }
  }
}

console.log('--- FALSE POSITIVES (labelled conflict, engine auto-matched) ---');
for (const [x, y] of CONFLICT_PAIRS) {
  const a = byKey.get(x);
  const b = byKey.get(y);
  if (!a || !b) { console.log('MISSING', x, y); continue; }
  const s = scorePair(a, b);
  if (s.decision === 'HIGH_CONFIDENCE_MATCH') console.log(`FP ${x} vs ${y} → ${s.decision} ${s.finalScore}`);
}
console.log('done');
