/**
 * The WordPress tab lists plugins, themes and admins from WP-CLI JSON. PHP
 * notices printed before the JSON start with a "[date]" bracket too, which
 * made every list parse as empty on a live site.
 */
import { describe, it, expect } from 'bun:test'
import { parseJsonArray } from '@/lib/vps/wordpress'

describe('WP-CLI list parsing', () => {
  it('skips PHP notices that start with a bracket', () => {
    const out = [
      '[24-Nov-2026 11:08:08 UTC] PHP Warning:  Undefined array key "HTTP_HOST" in /var/www/html/wp-includes/functions.php on line 6473',
      'Warning: Undefined array key "HTTP_HOST" in /var/www/html/wp-includes/functions.php on line 6473',
      '[{"name":"twentytwentyfive","status":"active"},{"name":"twentytwentyfour","status":"inactive"}]',
    ].join('\n')
    expect(parseJsonArray<{ name: string }>(out).map((t) => t.name)).toEqual(['twentytwentyfive', 'twentytwentyfour'])
  })
  it('reads a clean list and returns [] when there is none', () => {
    expect(parseJsonArray('[{"user_login":"admin"}]')).toEqual([{ user_login: 'admin' }])
    expect(parseJsonArray('Error: not installed')).toEqual([])
    expect(parseJsonArray('')).toEqual([])
  })
})
