/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev-only isolation: when NEXT_DEV_DIST is set (development launcher), keep
  // dev compiler artifacts out of the production .next directory that the
  // frozen 63030 demo server serves from. Unset (normal builds/prod) = ".next",
  // byte-identical behavior.
  distDir: process.env.NEXT_DEV_DIST ? '.next-dev' : '.next',
  // The PostgreSQL executor spawns a worker from a generated source file; pg
  // is required only inside that string, so the bundler never sees it. Keep
  // it external and traced so node_modules/pg ships with the serverless
  // bundle and the worker can resolve it at runtime.
  serverExternalPackages: ['pg'],
  // /evaluation reads these non-secret fixtures from data/evaluation/ at
  // runtime (ground truth + run history). Standalone/serverless file tracing
  // does not follow path-joined strings, so they are included explicitly.
  outputFileTracingIncludes: {
    '/evaluation': ['./data/evaluation/ground-truth-pairs.json', './data/evaluation/run-history.json'],
  },
};

export default nextConfig;
