import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Translations (src/i18n). The locale comes from a cookie, not the URL.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    // Type errors now FAIL the build. This was `true`, which hid 106 errors —
    // among them a 2FA handler calling an out-of-scope setter (so enabling 2FA
    // reported "Verification failed" after succeeding), a Stripe field that
    // moved onto subscription items (periods silently read undefined), and a
    // domain import attributing rows to a non-existent user id.
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  experimental: {
    // Request bodies passing through src/proxy.ts are buffered and cut off
    // at this size (default 10 MB, silently), which broke every upload over
    // 10 MB. Keep in sync with PROXY_BODY_LIMIT_BYTES in
    // src/lib/request-limits.ts; upload routes refuse anything larger with a
    // clear 413, and big files use the chunked site import or SFTP.
    proxyClientMaxBodySize: 100 * 1024 * 1024,
  },
  // SECURITY: hide Next.js version from HTTP response headers
  poweredByHeader: false,
  // SECURITY: comprehensive security headers applied to every response
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // HSTS — force HTTPS for 2 years (incl. subdomains)
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          // Don't sniff MIME types
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Clickjacking protection
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          // Referrer policy — only send origin to same origin
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Permissions policy — deny camera, microphone, geolocation
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          // XSS protection (legacy browsers)
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          // CORS — same origin only by default; API routes opt-in per-route
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          // Don't allow the page to be embedded in cross-origin iframes
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
    ]
  },
  serverExternalPackages: [
    "ssh2",
    "better-sqlite3",
    "@prisma/client",
    "bcryptjs",
    "node-cron",
    "nodemailer",
    "ssh2-streams",
  ],
};

export default withNextIntl(nextConfig);
