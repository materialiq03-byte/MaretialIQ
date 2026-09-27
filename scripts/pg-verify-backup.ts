/**
 * Step 11 §D — structural validation of a MaterialIQ pg backup directory.
 *
 * A successful backup command exit is NOT sufficient: this script proves the
 * artifact is actually usable.
 *  - every JSONL line parses as JSON
 *  - match_candidates.evidence is valid JSON (or null)
 *  - timestamp fields parse as instants (they were dumped as full-fidelity text)
 *  - manifest checksums match actual file contents (tamper/corruption check)
 *  - expected frozen row counts are present
 *
 * Usage: npx tsx scripts/pg-verify-backup.ts <backupDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EXPECTED_CORE: Record<string, number> = {
  organizations: 5,
  users: 5,
  material_records: 120,
  material_attributes: 691,
  match_candidates: 1289,
  review_queue: 1289,
  match_decisions: 10,
  common_materials: 1,
  material_mappings: 3,
  audit_logs: 62,
  evaluation_runs: 5,
  matching_runs: 0,
  matching_run_chunks: 0,
  import_runs: 0,
  import_run_chunks: 0,
  import_rows: 0,
};

const TIMESTAMP_HINT = /_at$|^timestamp$|created|updated|started|completed|opened|heartbeat/;

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main(): Promise<void> {
  const dir = path.resolve(process.argv[2] || '');
  if (!dir || !fs.existsSync(path.join(dir, 'manifest.json'))) {
    console.error('usage: npx tsx scripts/pg-verify-backup.ts <backupDir containing manifest.json>');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const tables = manifest.tables as Record<string, { rows: number; file: string; sha256: string; bytes: number }>;

  console.log(`Validating ${dir}`);
  console.log(`Source server: ${manifest.sourceServerVersion}, created ${manifest.createdAt}`);

  // 1. manifest checksums match file contents
  let manifestOk = true;
  for (const [name, meta] of Object.entries(tables)) {
    const body = fs.readFileSync(path.join(dir, meta.file), 'utf8');
    if (sha256(body) !== meta.sha256) {
      check(false, `manifest checksum: ${name}`);
      manifestOk = false;
    }
  }
  check(manifestOk, `manifest checksums match file contents (${Object.keys(tables).length} files)`);

  // 2. per-table structural validation
  const counts: Record<string, number> = {};
  let evidenceOk = true;
  let evidenceCount = 0;
  let timestampsOk = true;
  for (const [name, meta] of Object.entries(tables)) {
    const body = fs.readFileSync(path.join(dir, meta.file), 'utf8');
    const lines = body ? body.split('\n').filter((l) => l.length > 0) : [];
    counts[name] = lines.length;
    if (lines.length !== meta.rows) {
      check(false, `${name}: line count matches manifest`, `${lines.length} vs ${meta.rows}`);
      continue;
    }
    let parsedOk = true;
    for (let i = 0; i < lines.length; i++) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(lines[i]);
      } catch (e) {
        check(false, `${name}: line ${i + 1} parses as JSON`, (e as Error).message);
        parsedOk = false;
        break;
      }
      // evidence jsonb validity: the backup stores jsonb as real JSON
      // structure (pg returns objects); a doubly-encoded string is also
      // accepted for SQLite-style backups.
      if (name === 'match_candidates' && row.evidence != null) {
        try {
          if (typeof row.evidence === 'object') {
            evidenceCount++;
          } else {
            JSON.parse(row.evidence as string);
            evidenceCount++;
          }
        } catch {
          evidenceOk = false;
          check(false, `match_candidates evidence valid JSON`, `line ${i + 1}`);
        }
      }
      // timestamp fidelity
      for (const [k, v] of Object.entries(row)) {
        if (v != null && typeof v === 'string' && TIMESTAMP_HINT.test(k)) {
          if (Number.isNaN(new Date(v).getTime())) {
            timestampsOk = false;
            check(false, `${name}.${k} timestamp parses`, `line ${i + 1}: ${String(v).slice(0, 40)}`);
          }
        }
      }
    }
    if (parsedOk) check(true, `${name}: ${lines.length} lines parse as JSON`);
  }

  // 3. evidence verdicts
  check(evidenceOk, `match_candidates.evidence valid JSON in all ${evidenceCount} non-null rows`);

  // 4. timestamps
  check(timestampsOk, 'all timestamp fields parse as instants');

  // 5. expected frozen counts
  let countsOk = true;
  for (const [name, expected] of Object.entries(EXPECTED_CORE)) {
    if (counts[name] !== expected) {
      countsOk = false;
      check(false, `${name} row count`, `${counts[name]} vs expected ${expected}`);
    }
  }
  check(countsOk, 'all expected row counts present (frozen baseline)');
  check(tables['sessions'] === undefined, 'sessions intentionally excluded from backup (Step 7A policy)');
  check(manifest.sessionsOnSource === 0, 'source sessions count recorded as 0 in manifest');

  const totalRows = Object.values(counts).reduce((s, n) => s + n, 0);
  console.log(`\n${failures === 0 ? 'BACKUP VALIDATION PASS' : 'BACKUP VALIDATION FAIL'} — ${totalRows} rows across ${Object.keys(counts).length} tables, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: Error) => {
  console.error(`VALIDATION ERROR: ${e.message}`);
  process.exit(1);
});
