/**
 * Vercel Preview runtime packaging tests — `npx tsx tests/vercel-preview-runtime.test.ts`.
 *
 * Covers the two deployment-packaging guarantees the Preview gate depends on:
 *   1. TLS trust material resolution for the PostgreSQL executor:
 *        - MATERIALIQ_PG_SSL_CA secret wins over the local file (serverless
 *          runtimes cannot package the gitignored certs/ directory),
 *        - the local certs/supabase-ca.crt file still works unchanged,
 *        - with NEITHER source the executor fails CLOSED (verify-full policy
 *          is never silently downgraded; TLS is never disabled).
 *   2. Evaluation fixtures required by /evaluation are part of the deployment
 *      payload, not just the developer's unignored working copy.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveSslConfig } from '../src/lib/db/pg-executor';

const repoRoot = path.resolve(__dirname, '..');
let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(' ok -', name);
  } catch (err) {
    failures.push(name + ' :: ' + (err as Error).message);
    console.log(' not ok -', name);
    console.log('   ' + String((err as Error).message).split('\n')[0]);
  }
}

const CA_ENV = 'MATERIALIQ_PG_SSL_CA';
const PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBszCCAVmgAwIBAgIUXd4 test pem body',
  '-----END CERTIFICATE-----',
].join('\n');

/** Run fn with a controlled env + a working directory isolated from the repo. */
function withSandbox(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miq-ssl-'));
  const cwd = process.cwd();
  const hadEnv = CA_ENV in process.env;
  const prevEnv = process.env[CA_ENV];
  delete process.env[CA_ENV];
  process.chdir(dir);
  try {
    fn(dir);
  } finally {
    process.chdir(cwd);
    if (hadEnv) process.env[CA_ENV] = prevEnv;
    else delete process.env[CA_ENV];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('env secret CA wins over any on-disk file and keeps rejectUnauthorized true', () => {
  withSandbox((dir) => {
    // Even when a local CA file exists, the explicit secret takes priority.
    fs.mkdirSync(path.join(dir, 'certs'));
    fs.writeFileSync(path.join(dir, 'certs', 'supabase-ca.crt'), 'file-pem');
    process.env[CA_ENV] = PEM;
    const cfg = resolveSslConfig() as Record<string, unknown>;
    assert.equal(cfg.rejectUnauthorized, true);
    assert.equal(cfg.ca, PEM);
    assert.equal(typeof cfg.servername, 'string');
  });
});

test('local certs/supabase-ca.crt still works when no secret is set', () => {
  withSandbox((dir) => {
    fs.mkdirSync(path.join(dir, 'certs'));
    fs.writeFileSync(path.join(dir, 'certs', 'supabase-ca.crt'), 'file-pem');
    const cfg = resolveSslConfig() as Record<string, unknown>;
    assert.equal(cfg.rejectUnauthorized, true);
    assert.equal(cfg.ca, 'file-pem');
  });
});

test('without any CA source the resolver fails closed with actionable guidance', () => {
  withSandbox(() => {
    assert.throws(
      () => resolveSslConfig(),
      (err: Error) => /no CA trust material/.test(err.message) && /MATERIALIQ_PG_SSL_CA/.test(err.message)
    );
  });
});

test('insecure mode is still refused at boot in production (fail-closed guard intact)', () => {
  // Wards against "fixing" the CA gap by relaxing the production boot guard.
  const { validateProductionEnv } = require('../src/lib/security/env-validation') as {
    validateProductionEnv: (env: NodeJS.ProcessEnv) => string[];
  };
  const problems = validateProductionEnv({ NODE_ENV: 'production', REQUIRE_AUTH: 'true', MATERIALIQ_PG_SSL: 'insecure' });
  assert.ok(problems.some((p) => /MATERIALIQ_PG_SSL=insecure/.test(p)));
});

test('ground-truth dataset is packaged with the deployment payload', () => {
  const dsPath = path.join(repoRoot, 'data', 'evaluation', 'ground-truth-pairs.json');
  assert.ok(fs.existsSync(dsPath), 'data/evaluation/ground-truth-pairs.json missing from repo payload');
  const ds = JSON.parse(fs.readFileSync(dsPath, 'utf8'));
  assert.ok(Array.isArray(ds.pairs) && ds.pairs.length >= 50, 'ground-truth pairs missing or truncated');
  assert.ok(ds.label_vocabulary && ds.label_vocabulary.MATCH, 'label vocabulary missing');
});

test('run history and per-CPSE fixtures are packaged', () => {
  assert.ok(fs.existsSync(path.join(repoRoot, 'data', 'evaluation', 'run-history.json')), 'run-history.json missing');
  for (const cpse of ['BHEL', 'CPCL', 'NLC', 'NTPC', 'SAIL']) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, 'data', 'evaluation', 'fixtures', cpse + '.csv')),
      `fixture ${cpse}.csv missing`
    );
  }
});

test('no SQLite database or secret artifacts are packaged into the repo payload', () => {
  // The deployment payload is the git-tracked file set: data/ may hold local
  // ignored databases, but anything TRACKED under data/ must be a fixture.
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const tracked = execFileSync('git', ['ls-files', 'data/'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.ok(tracked.length >= 7, 'evaluation fixtures are not tracked: ' + tracked.join(', '));
  const forbidden = tracked.filter((f) => /\.(db|db-wal|db-shm|env)$|\.pem$|credential|secret/i.test(f));
  assert.deepEqual(forbidden, []);
  // And the tracked set is exactly the evaluation fixture surface.
  for (const f of tracked) {
    assert.ok(f.startsWith('data/evaluation/'), 'unexpected tracked artifact under data/: ' + f);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error('FAILED: ' + f);
  process.exit(1);
}
