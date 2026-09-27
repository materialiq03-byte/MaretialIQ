/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev-only isolation: when NEXT_DEV_DIST is set (development launcher), keep
  // dev compiler artifacts out of the production .next directory that the
  // frozen 63030 demo server serves from. Unset (normal builds/prod) = ".next",
  // byte-identical behavior.
  distDir: process.env.NEXT_DEV_DIST ? '.next-dev' : '.next',
};

export default nextConfig;
