/**
 * Step 25 — production environment guard, executed at SERVER BOOT.
 *
 * Next.js runs `register()` in instrumentation.ts once when the server
 * process starts (next start / next dev) — NOT during `next build` (which
 * also runs with NODE_ENV=production but is compilation, not serving). This
 * is the reliable fail-fast point: a misconfigured production deployment
 * refuses to boot instead of serving unauthenticated data.
 *
 * Belt-and-suspenders pair with pg-executor.ts, which independently refuses
 * MATERIALIQ_PG_SSL=insecure at connection time in production.
 */
export async function register(): Promise<void> {
  // Imported dynamically so edge/tooling contexts that load instrumentation
  // metadata never pull Node-only code at import time.
  const { validateProductionEnv, validateEnvWarnings } = await import('./lib/security/env-validation');
  const problems = validateProductionEnv(process.env);
  if (problems.length > 0) {
    console.error('\n======================================================');
    console.error('MATERIALIQ: refusing to start — unsafe production configuration:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('======================================================\n');
    // Fail-fast abort. On a regular Node server (next start / Docker /
    // self-hosted) process.exit(1) hard-stops the process. On Vercel's
    // serverless instrumentation runtime `process.exit` does not exist
    // (TypeError: process.exit is not a function), so there we throw — the
    // Next.js-compatible way to abort the instrumentation hook; Vercel
    // surfaces the error and the deployment never serves traffic. The
    // validation itself is unchanged: the same unsafe configurations are
    // refused on every platform.
    if (typeof process.exit === 'function') {
      process.exit(1);
    }
    throw new Error(
      'MATERIALIQ refusing to start — unsafe production configuration:\n' +
        problems.map((p) => `  - ${p}`).join('\n')
    );
  }
  for (const w of validateEnvWarnings(process.env)) {
    console.warn(`MATERIALIQ config warning: ${w}`);
  }
}
