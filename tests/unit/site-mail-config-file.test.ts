/**
 * Mail settings live in their own file so turning email on never regenerates
 * wp-config.php (doing that took a live imported site down).
 */
import { describe, expect, test } from 'bun:test'
import {
  WP_MAIL_CONFIG_NAME,
  WP_MAIL_CONFIG_PATH,
  WP_MAIL_PLUGIN,
  wordPressMailConfigFile,
} from '../../src/lib/site-mail-config'

const rt = {
  host: 'mail.example.test',
  port: 587,
  user: 'site-x@example.test',
  password: "p'ss\\word",
  from: 'site-x@example.test',
  fromName: 'Shop',
} as Parameters<typeof wordPressMailConfigFile>[0]

describe('mail settings file', () => {
  test('sits in wp-content, outside mu-plugins', () => {
    expect(WP_MAIL_CONFIG_PATH).toBe(`wp-content/${WP_MAIL_CONFIG_NAME}`)
    expect(WP_MAIL_CONFIG_PATH).not.toContain('mu-plugins')
  })

  test('only defines constants and exits when opened directly', () => {
    const php = wordPressMailConfigFile(rt)
    expect(php.startsWith('<?php\n')).toBe(true)
    expect(php).toContain("if (!defined('ABSPATH')) { exit; }")
    expect(php).toContain("define('APSAMO_SMTP_HOST', 'mail.example.test');")
    expect(php).toContain("define('APSAMO_SMTP_PORT', 587);")
    // The password is escaped for a single-quoted PHP string.
    expect(php).toContain("define('APSAMO_SMTP_PASS', 'p\\'ss\\\\word');")
    expect(php).not.toMatch(/echo|print|\?>/)
  })

  test('the plugin loads the settings file when wp-config has none', () => {
    expect(WP_MAIL_PLUGIN).toContain(`WP_CONTENT_DIR . '/${WP_MAIL_CONFIG_NAME}'`)
    const load = WP_MAIL_PLUGIN.indexOf(`require WP_CONTENT_DIR`)
    const guard = WP_MAIL_PLUGIN.indexOf(`if (!defined('APSAMO_SMTP_HOST') || !defined('APSAMO_SMTP_USER')`)
    expect(load).toBeGreaterThan(0)
    expect(load).toBeLessThan(guard)
  })
})
