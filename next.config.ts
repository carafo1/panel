import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
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

export default nextConfig;
