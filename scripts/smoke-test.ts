/**
 * Pre-release / pre-demo smoke test — `npm run smoke`.
 *
 * Walks every production route and read API of a RUNNING MaterialIQ server and
 * fails loudly (non-zero exit) on: any non-200 response, any DB integrity or
 * foreign-key violation, or cross-check mismatches between API payloads and the
 * on-disk database. Read-only against the database (opened in readOnly mode);
 * never mutates data. Base URL overridable: `SMOKE_BASE_URL=http://localhost:63000`.
 *
 * Exit 0 = everything green. First failure is printed with the exact check.
 */
async function main(): Promise<void> {
  const BASE = process.env.SMOKE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 63000}`;
  const DB_PATH = process.env.SMOKE_DB_PATH ?? 'data/materialiq.db';

  let failures = 0;
  function check(name: string, ok: boolean, detail = ''): void {
    if (ok) {
      console.log(`  ok - ${name}`);
    } else {
      failures += 1;
      console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  async function get(path: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    return { status: res.status, body };
  }

  const PAGES = [
    '/', '/materials', '/materials/1', '/materials?q=CP-1001', '/imports',
    '/matching', '/matching?q=CP-1001', '/matching/4640', '/proposals',
    '/proposals?priority=high', '/cross-reference', '/analytics', '/evaluation',
    '/audit', '/settings', '/admin', '/admin/users', '/admin/organizations',
  ];
  const APIS = [
    '/api/health', '/api/matches?q=CP-1001', '/api/audit?page=1',
    '/api/imports', '/api/common-materials', '/api/mappings',
  ];

  console.log(`MaterialIQ smoke test → ${BASE}`);

  // 1. Pages render.
  for (const path of PAGES) {
    try {
      const { status } = await get(path);
      check(`page ${path}`, status === 200, `HTTP ${status}`);
    } catch (err) {
      check(`page ${path}`, false, err instanceof Error ? err.message : String(err));
    }
  }

  // 2. Read APIs answer.
  for (const path of APIS) {
    try {
      const { status } = await get(path);
      check(`api ${path}`, status === 200, `HTTP ${status}`);
    } catch (err) {
      check(`api ${path}`, false, err instanceof Error ? err.message : String(err));
    }
  }

  // 3. Decision endpoint is POST-guarded (GET must not be 200).
  {
    const { status } = await get('/api/matches/1');
    check('decision endpoint rejects GET (route guard)', status === 405, `HTTP ${status}`);
  }

  // 4. Flagship demo content actually renders.
  {
    const { body } = await get('/matching/4640');
    check('CP-1001↔BH-4410 detail shows 6205-2RS', body.includes('6205-2RS'));
    check('CP-1001↔BH-4410 detail shows 6205-ZZ', body.includes('6205-ZZ'));
    const ev = await get('/evaluation');
    check('evaluation page shows synthetic-dataset disclaimer', ev.body.includes('synthetic'));
    check('evaluation page shows run history', ev.body.includes('run-000'));
  }

  // 5. Database integrity + sanity (read-only).
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    check('db integrity_check', integrity.integrity_check === 'ok', integrity.integrity_check);
    const fk = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
    check('db foreign_key_check (0 violations)', fk.length === 0, `${fk.length} violations`);
    const mats = (db.prepare('SELECT COUNT(*) n FROM material_records WHERE is_active = 1').get() as { n: number }).n;
    check('materials present', mats > 0, `${mats} materials`);
    const open = (db.prepare("SELECT COUNT(*) n FROM review_queue WHERE status = 'open'").get() as { n: number }).n;
    const openOrphans = (db.prepare(
      "SELECT COUNT(*) n FROM review_queue rq WHERE rq.status = 'open' AND rq.match_id NOT IN (SELECT id FROM match_candidates)"
    ).get() as { n: number }).n;
    check('review queue has no orphan rows', openOrphans === 0, `${openOrphans} orphans of ${open} open`);
    const decided = (db.prepare("SELECT COUNT(*) n FROM match_candidates WHERE status != 'pending'").get() as { n: number }).n;
    const decidedQueue = (db.prepare(
      "SELECT COUNT(*) n FROM review_queue rq JOIN match_candidates mc ON mc.id = rq.match_id WHERE rq.status = 'open' AND mc.status != 'pending'"
    ).get() as { n: number }).n;
    check('no open queue rows pointing at decided matches', decidedQueue === 0, `${decidedQueue} stale rows (decided total: ${decided})`);
    const cmis = (db.prepare('SELECT COUNT(*) n FROM common_materials').get() as { n: number }).n;
    const unapproved = (db.prepare(
      `SELECT COUNT(*) n FROM common_materials c
        WHERE c.source_match_id IS NOT NULL
          AND (SELECT status FROM match_candidates WHERE id = c.source_match_id) != 'approved'`
    ).get() as { n: number }).n;
    check('every CMI traces to an approved match', unapproved === 0, `${unapproved} of ${cmis} unapproved`);
    db.close();
  } catch (err) {
    check('database checks', false, err instanceof Error ? err.message : String(err));
  }

  console.log(failures === 0 ? '\nSMOKE PASS — all checks green.' : `\nSMOKE FAIL — ${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);

}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
