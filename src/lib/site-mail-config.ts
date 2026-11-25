/**
 * Outgoing mail for customer websites — pure helpers (no database, no I/O).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Customer sites run in Docker containers built from the official images,
 * which ship no MTA: PHP's mail() fails ("sendmail: can't connect") and every
 * contact form, password reset and WooCommerce order email was lost.
 *
 * Each site now authenticates to Mailcow's submission port (587, STARTTLS)
 * with its own mailbox (see lib/site-mail.ts):
 *
 *   WordPress  a managed must-use plugin (wp-content/mu-plugins/apsamo-mail.php)
 *              points PHPMailer at Mailcow from `phpmailer_init`. Credentials
 *              are constants in the managed wp-config.php, never in the plugin.
 *   PHP        the generated image installs msmtp and sets php's
 *              sendmail_path to it; the password reaches msmtp through the
 *              APSAMO_SMTP_PASS container environment variable.
 *
 * How the container reaches the mail server: by its PUBLIC hostname
 * (MAIL_SERVER_HOSTNAME, overridable with SITE_MAIL_SMTP_HOST). The name has
 * a valid certificate, so STARTTLS verifies normally. When Mailcow runs on the
 * same host, Docker's DNAT rules for the published port 587 also apply to
 * traffic a container sends to the host's own public address, so the
 * connection never leaves the machine. Joining customer containers to
 * Mailcow's internal network instead was rejected: it would expose Mailcow's
 * MySQL / Redis / Dovecot internals to every customer site.
 *
 * Everything in this file is unit-tested (tests/unit/site-mail.test.ts).
 */
import { MAIL_SERVER_HOSTNAME, NO_REPLY_EMAIL } from '@/lib/brand-config'

/** Deployment methods that get a sending identity. */
export const SITE_MAIL_METHODS = ['wordpress', 'php'] as const
export type SiteMailMethod = (typeof SITE_MAIL_METHODS)[number]

export function isSiteMailMethod(m: string | null | undefined): m is SiteMailMethod {
  return !!m && (SITE_MAIL_METHODS as readonly string[]).includes(m)
}

/** What a site needs at runtime to send. `password` is plaintext: never log it. */
export interface SiteMailRuntime {
  host: string
  port: number
  /** Mailbox login, and the envelope sender (Return-Path). */
  user: string
  password: string
  /** Header From (the site mailbox, or an owner address allowed by sender ACL). */
  from: string
  fromName: string | null
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
/** Conservative address syntax: nothing that needs quoting in PHP, YAML or sh. */
export const EMAIL_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export function isSafeHostname(h: string): boolean {
  return HOST_RE.test(h)
}

export function isSafeEmail(a: string): boolean {
  return a.length <= 254 && EMAIL_RE.test(a) && !a.includes('..')
}

/** The platform domain site mailboxes live on. Must exist in Mailcow. */
export function siteMailDomain(): string {
  const configured = (process.env.SITE_MAIL_DOMAIN || '').trim().toLowerCase()
  if (configured) return configured
  return (NO_REPLY_EMAIL.split('@')[1] || '').trim().toLowerCase()
}

export function siteMailSmtpHost(): string {
  return ((process.env.SITE_MAIL_SMTP_HOST || '').trim() || MAIL_SERVER_HOSTNAME).toLowerCase()
}

export function siteMailSmtpPort(): number {
  const n = Number(process.env.SITE_MAIL_SMTP_PORT || 587)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 587
}

export function siteMailRateLimitPerHour(): number {
  const n = Number(process.env.SITE_MAIL_RATE_LIMIT_PER_HOUR || 100)
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : 100
}

export function siteMailQuotaMB(): number {
  const n = Number(process.env.SITE_MAIL_QUOTA_MB || 100)
  return Number.isInteger(n) && n > 0 ? n : 100
}

/**
 * `site-<slug>` (optionally `-<suffix>`), safe and at most 64 characters —
 * the RFC 5321 local-part limit.
 */
export function siteMailLocalPart(slug: string, suffix?: string): string {
  const clean = (slug || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'site'
  const tail = suffix ? `-${suffix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}` : ''
  const room = 64 - 'site-'.length - tail.length
  return `site-${clean.slice(0, room).replace(/-+$/g, '')}${tail}`
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/**
 * 32 random characters from an unambiguous alphanumeric alphabet (~187 bits).
 * Alphanumeric on purpose: the value is written into PHP source, a compose
 * file and an environment variable, and nothing in it may need escaping.
 */
export function generateSiteMailPassword(randomInt: (max: number) => number): string {
  let out = ''
  for (let i = 0; i < 32; i++) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]
  return out
}

/** A PHP single-quoted string literal. */
export function phpString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Display name: printable, no header-breaking characters, at most 100 chars. */
export function cleanFromName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') throw new Error('fromName must be a string')
  if (/[\u0000-\u001f\u007f<>"]/.test(raw)) throw new Error('fromName contains characters that are not allowed')
  const t = raw.trim()
  if (t.length > 100) throw new Error('fromName must be 100 characters or fewer')
  return t || null
}

/**
 * Lines for the managed wp-config.php. Empty when mail is off, which leaves
 * the mu-plugin inert (it only acts when the constants exist).
 */
export function wordPressMailDefines(rt: SiteMailRuntime | null): string {
  if (!rt) return ''
  return [
    '// Outgoing mail through the hosting mail server (managed by Apsamo Panel;',
    '// used by wp-content/mu-plugins/apsamo-mail.php). Rewritten on every deploy.',
    `define('APSAMO_SMTP_HOST', ${phpString(rt.host)});`,
    `define('APSAMO_SMTP_PORT', ${Math.floor(rt.port)});`,
    `define('APSAMO_SMTP_USER', ${phpString(rt.user)});`,
    `define('APSAMO_SMTP_PASS', ${phpString(rt.password)});`,
    `define('APSAMO_SMTP_FROM', ${phpString(rt.from)});`,
    `define('APSAMO_SMTP_FROM_NAME', ${phpString(rt.fromName || '')});`,
    '',
  ].join('\n')
}

export const WP_MAIL_PLUGIN_PATH = 'wp-content/mu-plugins/apsamo-mail.php'

/** The settings file the plugin loads, inside wp-content (not a plugin). */
export const WP_MAIL_CONFIG_NAME = 'apsamo-mail-config.php'
export const WP_MAIL_CONFIG_PATH = `wp-content/${WP_MAIL_CONFIG_NAME}`

/**
 * Contents of the settings file. Exits when requested directly over HTTP, so
 * it can never print anything; holds only constants.
 */
export function wordPressMailConfigFile(rt: SiteMailRuntime): string {
  return [
    '<?php',
    "if (!defined('ABSPATH')) { exit; }",
    wordPressMailDefines(rt),
  ].join('\n')
}

/**
 * The must-use plugin. Static text: all configuration comes from constants.
 *
 * From handling: Mailcow only lets a login send as its own address (plus its
 * sender ACL), so a plugin-chosen From (wordpress@host, a contact form setting
 * From to the visitor) would be rejected outright. The From is therefore
 * always the allowed address; the original sender becomes Reply-To when no
 * Reply-To was set, so "reply" on a contact-form email still reaches the
 * visitor. The envelope sender is the site mailbox so bounces land there.
 */
export const WP_MAIL_PLUGIN = `<?php
/**
 * Plugin Name: Apsamo Mail
 * Description: Sends WordPress email through the hosting mail server (SMTP). Managed by Apsamo Panel; this file is replaced on every deploy.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) {
    exit;
}
// Settings live in their own file (written by the panel), so applying them
// never regenerates wp-config.php.
if (!defined('APSAMO_SMTP_HOST') && defined('WP_CONTENT_DIR') && is_readable(WP_CONTENT_DIR . '/${WP_MAIL_CONFIG_NAME}')) {
    require WP_CONTENT_DIR . '/${WP_MAIL_CONFIG_NAME}';
}
if (!defined('APSAMO_SMTP_HOST') || !defined('APSAMO_SMTP_USER') || !defined('APSAMO_SMTP_PASS')) {
    return;
}

add_action('phpmailer_init', function ($phpmailer) {
    $phpmailer->isSMTP();
    $phpmailer->Host = APSAMO_SMTP_HOST;
    $phpmailer->Port = defined('APSAMO_SMTP_PORT') ? (int) APSAMO_SMTP_PORT : 587;
    $phpmailer->SMTPAuth = true;
    $phpmailer->SMTPSecure = ($phpmailer->Port === 465) ? 'ssl' : 'tls';
    $phpmailer->SMTPAutoTLS = true;
    $phpmailer->Username = APSAMO_SMTP_USER;
    $phpmailer->Password = APSAMO_SMTP_PASS;
    $phpmailer->Timeout = 20;

    $allowed = (defined('APSAMO_SMTP_FROM') && APSAMO_SMTP_FROM) ? APSAMO_SMTP_FROM : APSAMO_SMTP_USER;
    $original = (string) $phpmailer->From;
    $originalName = (string) $phpmailer->FromName;
    if ($original !== '' && strcasecmp($original, $allowed) !== 0
        && stripos($original, 'wordpress@') !== 0
        && count($phpmailer->getReplyToAddresses()) === 0) {
        $phpmailer->addReplyTo($original, $originalName);
    }
    $name = (defined('APSAMO_SMTP_FROM_NAME') && APSAMO_SMTP_FROM_NAME) ? APSAMO_SMTP_FROM_NAME : $originalName;
    if ($name === '' || $name === 'WordPress') {
        $name = wp_specialchars_decode(get_bloginfo('name'), ENT_QUOTES);
    }
    $phpmailer->setFrom($allowed, $name, false);
    $phpmailer->Sender = APSAMO_SMTP_USER;
}, 999);

add_action('wp_mail_failed', function ($error) {
    if (is_wp_error($error)) {
        error_log('apsamo-mail: ' . $error->get_error_message());
    }
});
`

/**
 * Dockerfile lines for a plain PHP (php:*-apache) image: msmtp as PHP's
 * sendmail. Host, port, login and From are baked in (not secret); the password
 * is read at send time from the APSAMO_SMTP_PASS environment variable, so it
 * is never part of an image layer. `set_from_header on` (msmtp >= 1.8.8)
 * forces the header From to the allowed address; older images skip it.
 * Single physical lines, like phpIniBlock.
 */
export function msmtpDockerfileBlock(rt: Omit<SiteMailRuntime, 'password'> | null): string {
  if (!rt) return ''
  // Interpolated into a RUN line: anything unexpected is refused (and the
  // image is built without mail) rather than written.
  if (!isSafeHostname(rt.host) || !isSafeEmail(rt.user) || !isSafeEmail(rt.from) || !Number.isInteger(rt.port)) {
    return '# Outgoing mail not configured: the mail settings failed validation.\n'
  }
  const port = Math.floor(rt.port)
  const lines = [
    'defaults',
    'auth on',
    'tls on',
    port === 465 ? 'tls_starttls off' : 'tls_starttls on',
    'tls_trust_file /etc/ssl/certs/ca-certificates.crt',
    'syslog off',
    'logfile /proc/self/fd/2',
    'account apsamo',
    `host ${rt.host}`,
    `port ${port}`,
    `user ${rt.user}`,
    'passwordeval "printenv APSAMO_SMTP_PASS"',
    `from ${rt.from}`,
    'account default : apsamo',
  ]
  const printf = `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')} > /etc/msmtprc`
  const fromHeader =
    `if dpkg --compare-versions "$(dpkg-query -W -f='\${Version}' msmtp)" ge 1.8.8; then ` +
    `sed -i "s/^account apsamo$/set_from_header on\\naccount apsamo/" /etc/msmtprc; fi`
  return [
    '# Outgoing mail: PHP mail() -> msmtp -> hosting mail server (managed by Apsamo Panel)',
    'RUN apt-get update && apt-get install -y --no-install-recommends msmtp ca-certificates && rm -rf /var/lib/apt/lists/*',
    `RUN ${printf} && ${fromHeader} && chmod 644 /etc/msmtprc && echo 'sendmail_path = "/usr/bin/msmtp -t -i"' > /usr/local/etc/php/conf.d/zz-apsamo-mail.ini`,
    '',
  ].join('\n')
}

/** Runtime environment the PHP container needs (password only). */
export function siteMailContainerEnv(rt: SiteMailRuntime | null): Record<string, string> {
  return rt ? { APSAMO_SMTP_PASS: rt.password } : {}
}

// ─── Request validation ───────────────────────────────────────────────────

export type SiteMailAction =
  | { action: 'enable'; fromAddress?: string | null; fromName?: string | null }
  | { action: 'disable' }
  | { action: 'rotate' }
  | { action: 'test' }

/** Parse POST /api/hosting/[id]/mail. Throws Error(message) on bad input. */
export function parseSiteMailAction(body: unknown): SiteMailAction {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request body must be a JSON object')
  const b = body as Record<string, unknown>
  const action = b.action
  if (action === 'disable' || action === 'rotate' || action === 'test') {
    const extra = Object.keys(b).filter((k) => k !== 'action')
    if (extra.length) throw new Error(`Unexpected field(s) for "${action}": ${extra.join(', ')}`)
    return { action }
  }
  if (action !== 'enable') throw new Error('action must be one of: enable, disable, rotate, test')
  const extra = Object.keys(b).filter((k) => !['action', 'fromAddress', 'fromName'].includes(k))
  if (extra.length) throw new Error(`Unexpected field(s): ${extra.join(', ')}`)
  const out: { action: 'enable'; fromAddress?: string | null; fromName?: string | null } = { action: 'enable' }
  if ('fromAddress' in b) {
    if (b.fromAddress === null || b.fromAddress === '') out.fromAddress = null
    else if (typeof b.fromAddress !== 'string') throw new Error('fromAddress must be a string or null')
    else {
      const a = b.fromAddress.trim().toLowerCase()
      if (!isSafeEmail(a)) throw new Error('fromAddress is not a valid email address')
      out.fromAddress = a
    }
  }
  if ('fromName' in b) out.fromName = cleanFromName(b.fromName)
  return out
}
