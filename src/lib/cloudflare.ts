/**
 * Cloudflare API client (CDN, WAF and DDoS protection for customer domains).
 *
 * The API token is set by an admin (Admin → Servers → Cloudflare, stored
 * encrypted) or with CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID. Without a
 * token the feature is simulated in development and unavailable in production
 * — and the pricing page stops advertising it (see billing/plans).
 *
 * The token needs: Zone:Edit, Zone Settings:Edit, DNS:Edit, Cache Purge, and
 * Account:Read (to find the account zones are created in).
 */
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'

const API = 'https://api.cloudflare.com/client/v4'
const TOKEN_KEY = 'cloudflare.apiToken'
const ACCOUNT_KEY = 'cloudflare.accountId'

export class CloudflareError extends Error {
  constructor(message: string, public status = 502, public code?: number) {
    super(message)
  }
}

export interface CloudflareConfig {
  token: string
  accountId: string | null
  source: 'settings' | 'env'
}

export async function cloudflareConfig(): Promise<CloudflareConfig | null> {
  const rows = await db.appSetting.findMany({ where: { key: { in: [TOKEN_KEY, ACCOUNT_KEY] } } }).catch(() => [])
  const tokenRow = rows.find((r) => r.key === TOKEN_KEY)
  if (tokenRow?.value) {
    try {
      return { token: decrypt(tokenRow.value), accountId: rows.find((r) => r.key === ACCOUNT_KEY)?.value || null, source: 'settings' }
    } catch {
      console.error('[cloudflare] stored token could not be decrypted')
    }
  }
  const envToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
  if (envToken) return { token: envToken, accountId: process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || null, source: 'env' }
  return null
}

/** No token, outside production: simulate so the feature can be developed and tested. */
export async function cloudflareMode(): Promise<'live' | 'demo' | 'off'> {
  if (await cloudflareConfig()) return 'live'
  return process.env.NODE_ENV === 'production' ? 'off' : 'demo'
}

type CfResponse<T> = { success: boolean; errors?: Array<{ code: number; message: string }>; result: T }

export async function cf<T>(config: Pick<CloudflareConfig, 'token'>, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      method: init.method || 'GET',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new CloudflareError(`Cloudflare could not be reached: ${err instanceof Error ? err.message : err}`)
  }
  const data = (await res.json().catch(() => null)) as CfResponse<T> | null
  if (!res.ok || !data?.success) {
    const e = data?.errors?.[0]
    throw new CloudflareError(e ? `Cloudflare: ${e.message}` : `Cloudflare returned HTTP ${res.status}`, res.status >= 500 ? 502 : 400, e?.code)
  }
  return data.result
}

/** Check a token works and find the account to create zones in. */
export async function verifyToken(token: string, accountId?: string | null): Promise<{ accountId: string; accountName: string }> {
  const cfg = { token }
  let ok = false
  try {
    const v = await cf<{ status: string }>(cfg, '/user/tokens/verify')
    ok = v.status === 'active'
  } catch {
    if (accountId) {
      const v = await cf<{ status: string }>(cfg, `/accounts/${encodeURIComponent(accountId)}/tokens/verify`)
      ok = v.status === 'active'
    }
  }
  if (!ok) throw new CloudflareError('That token is not active.', 400)
  const accounts = await cf<Array<{ id: string; name: string }>>(cfg, '/accounts?per_page=50')
  const acct = accountId ? accounts.find((a) => a.id === accountId) : accounts[0]
  if (!acct) throw new CloudflareError(accountId ? 'The token cannot see that account.' : 'The token cannot see any Cloudflare account (it needs Account:Read).', 400)
  return { accountId: acct.id, accountName: acct.name }
}

export async function saveCloudflareSettings(token: string, accountId: string | null, userId: string) {
  const verified = await verifyToken(token, accountId)
  await db.$transaction([
    db.appSetting.upsert({ where: { key: TOKEN_KEY }, create: { key: TOKEN_KEY, value: encrypt(token), updatedBy: userId }, update: { value: encrypt(token), updatedBy: userId } }),
    db.appSetting.upsert({ where: { key: ACCOUNT_KEY }, create: { key: ACCOUNT_KEY, value: verified.accountId, updatedBy: userId }, update: { value: verified.accountId, updatedBy: userId } }),
  ])
  return verified
}

export async function clearCloudflareSettings() {
  await db.appSetting.deleteMany({ where: { key: { in: [TOKEN_KEY, ACCOUNT_KEY] } } })
}

export async function accountIdFor(config: CloudflareConfig): Promise<string> {
  if (config.accountId) return config.accountId
  const accounts = await cf<Array<{ id: string }>>(config, '/accounts?per_page=1')
  if (!accounts[0]) throw new CloudflareError('The Cloudflare token cannot see any account.')
  return accounts[0].id
}
