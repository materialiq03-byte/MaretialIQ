/**
 * Step 25 — production environment validation. Called from next.config.mjs at
 * config-evaluation time (i.e. during `next build` AND `next start`).
 *
 * Fail fast on dangerous production configurations:
 *  - MATERIALIQ_PG_SSL=insecure must never be the silent production default —
 *    it is a local-development convenience only (pg-executor.ts still refuses
 *    it in production and prints guidance, so this is belt-and-suspenders).
 *  - In production, authentication MUST be explicitly enabled or explicitly
 *    accepted: REQUIRE_AUTH=true enables the session gate; REQUIRE_AUTH=false
 *    (or unset) is the SIH prototype identity and must be consciously chosen
 *    via ALLOW_PROTOTYPE_MODE_IN_PRODUCTION=true to boot in production.
 *  - Demo role switching stays out of production unless explicitly allowed
 *    (mirrors auth/service.isDemoModeEnabled()).
 *
 * Warnings are non-fatal and are printed for operators.
 *
 * IMPORTANT (no security theater): these checks validate CONFIGURATION, not
 * runtime behavior. They cannot prove a deployment is secure; they ensure the
 * known-dangerous configurations cannot boot silently.
 */

export function validateProductionEnv(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== 'production') return [];
  // `next build` also runs with NODE_ENV=production (NEXT_PHASE=phase-
  // production-build). Compilation is not serving: the fatal checks apply
  // only when the server actually STARTS (next start / next dev never sets
  // the phase, so serving keeps the guard).
  if (env.NEXT_PHASE === 'phase-production-build') return [];
  const problems: string[] = [];

  // TLS: insecure PG mode never boots in production — no override flag, no
  // exception (fail-closed; insecure mode remains a local-development
  // convenience only, and pg-executor.ts enforces the same at connect time).
  if ((env.MATERIALIQ_PG_SSL ?? '').trim().toLowerCase() === 'insecure') {
    problems.push(
      'MATERIALIQ_PG_SSL=insecure in production refuses to boot (TLS certificate validation disabled). ' +
        'Use the default certificate-validated TLS; insecure mode is a local-development convenience only.'
    );
  }

  // Authentication: prototype identity must never be implicit in production.
  const requireAuth = env.REQUIRE_AUTH === 'true';
  if (!requireAuth && env.ALLOW_PROTOTYPE_MODE_IN_PRODUCTION !== 'true') {
    problems.push(
      'REQUIRE_AUTH is not enabled for production. The SIH prototype identity (full-permission, ' +
        'no login) would serve every request. Set REQUIRE_AUTH=true, or set ' +
        'ALLOW_PROTOTYPE_MODE_IN_PRODUCTION=true to consciously run the demo configuration.'
    );
  }

  // Demo role switching: allowed only with the explicit escape hatch.
  if (env.ALLOW_DEMO_SWITCH !== 'true') {
    // auth/service.isDemoModeEnabled() already blocks it in production — nothing to add.
  }

  return problems;
}

/** Non-fatal operator warnings for risky-but-permitted configurations. */
export function validateEnvWarnings(env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = [];
  if (env.NODE_ENV === 'production') {
    if (env.REQUIRE_AUTH !== 'true' && env.ALLOW_PROTOTYPE_MODE_IN_PRODUCTION === 'true') {
      warnings.push('Running production with the SIH prototype identity enabled (explicitly accepted).');
    }
    if (env.ALLOW_DEMO_SWITCH === 'true') {
      warnings.push('Demo role switching is enabled in production (ALLOW_DEMO_SWITCH=true).');
    }
  } else {
    if ((env.MATERIALIQ_PG_SSL ?? '').trim().toLowerCase() === 'insecure') {
      warnings.push('Development mode: PostgreSQL TLS certificate validation disabled (development convenience).');
    }
  }
  return warnings;
}
