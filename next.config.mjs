/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev-only isolation: when NEXT_DEV_DIST is set (development launcher), keep
  // dev compiler artifacts out of the production .next directory that the
  // frozen 63030 demo server serves from. Unset (normal builds/prod) = ".next",
  // byte-identical behavior.
  distDir: process.env.NEXT_DEV_DIST ? '.next-dev' : '.next',
  // /evaluation reads these non-secret fixtures from data/evaluation/ at
  // runtime (ground truth + run history). Standalone/serverless file tracing
  // does not follow path-joined strings, so they are included explicitly.
  outputFileTracingIncludes: {
    '/evaluation': ['./data/evaluation/ground-truth-pairs.json', './data/evaluation/run-history.json'],
  },
};

export default nextConfig;
