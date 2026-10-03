import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// In development the browser calls /api on the web origin and Next forwards it to the API, the
// same shape as staging, where Caddy routes /api/* to the API. Production builds have no rewrite.
const apiDevUrl = process.env.API_DEV_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@nolon/shared'],
  rewrites() {
    if (process.env.NODE_ENV === 'production') return Promise.resolve([]);
    return Promise.resolve([{ source: '/api/:path*', destination: `${apiDevUrl}/api/:path*` }]);
  },
};

export default withNextIntl(nextConfig);
