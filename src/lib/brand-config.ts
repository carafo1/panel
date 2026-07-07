/**
 * APSAMO brand configuration — env-var configurable with sensible defaults.
 *
 * Existing deployments can override these via environment variables to keep
 * their current DNS hostnames and email mailboxes working after the
 * DeployHub → APSAMO rebrand. New installations get APSAMO defaults out of
 * the box.
 *
 * Override examples (for an existing deployhub.io deployment):
 *   BRAND_DOMAIN=deployhub.io
 *   MAIL_SERVER_HOSTNAME=mail.deployhub.io
 *   NS1_HOSTNAME=ns1.deployhub.io
 *   NS2_HOSTNAME=ns2.deployhub.io
 *   NO_REPLY_EMAIL=no-reply@deployhub.local
 *   SUPPORT_EMAIL=support@deployhub.io
 *   BILLING_EMAIL=billing@deployhub.io
 *   ADMIN_EMAIL=admin@deployhub.io
 *
 * See `.env.example` for the full list.
 */

// DNS infrastructure hostnames
export const BRAND_DOMAIN = process.env.BRAND_DOMAIN || 'apsamo.com'
export const MAIL_SERVER_HOSTNAME =
  process.env.MAIL_SERVER_HOSTNAME || `mail.${BRAND_DOMAIN}`
export const NS1_HOSTNAME = process.env.NS1_HOSTNAME || `ns1.${BRAND_DOMAIN}`
export const NS2_HOSTNAME = process.env.NS2_HOSTNAME || `ns2.${BRAND_DOMAIN}`
export const APP_SUBDOMAIN_PATTERN =
  process.env.APP_SUBDOMAIN_PATTERN || `{slug}.${BRAND_DOMAIN}`

// Email mailboxes
export const NO_REPLY_EMAIL = process.env.NO_REPLY_EMAIL || `no-reply@${BRAND_DOMAIN}`
export const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || `support@${BRAND_DOMAIN}`
export const BILLING_EMAIL = process.env.BILLING_EMAIL || `billing@${BRAND_DOMAIN}`
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || `admin@${BRAND_DOMAIN}`

// From name/email for outgoing email
export const FROM_EMAIL = process.env.SMTP_FROM_EMAIL || NO_REPLY_EMAIL
export const FROM_NAME = process.env.SMTP_FROM_NAME || 'Apsamo Technology'
