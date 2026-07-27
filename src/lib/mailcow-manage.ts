/**
 * Mailcow management operations
 * =============================
 *
 * The panel-native email management layer: aliases, forwarding, catch-all,
 * spam policy, quarantine, logs and usage statistics. `mailcow.ts` owns domain
 * and mailbox lifecycle; this module adds everything a hosting customer manages
 * around those mailboxes so they never need to open Mailcow itself.
 *
 * TENANT ISOLATION: nothing here is safe to expose on its own. Every function
 * takes the caller's own domain list and filters Mailcow's (server-wide)
 * responses down to it, so one customer can never see another's aliases,
 * quarantine or logs. Routes must pass the domains resolved from the project.
 */

// ─── Transport ─────────────────────────────────────────────────────────────

interface MailcowConfig {
  url: string
  key: string
}

function getConfig(): MailcowConfig | null {
  const url = process.env.MAILCOW_API_URL
  const key = process.env.MAILCOW_API_KEY
  if (!url || !key) return null
  return { url: url.replace(/\/+$/, ''), key }
}

export function isMailcowConfigured(): boolean {
  return getConfig() !== null
}

function apiBase(cfg: MailcowConfig): string {
  return /\/api\/v\d+$/.test(cfg.url) ? cfg.url : `${cfg.url}/api/v1`
}

async function mc<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cfg = getConfig()
  if (!cfg) throw new Error('Mail server is not configured')
  const res = await fetch(`${apiBase(cfg)}${path}`, {
    ...init,
    headers: {
      'X-API-Key': cfg.key,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`Mail server returned ${res.status}`)
  }
  if (res.status === 204) return [] as unknown as T
  const text = await res.text()
  if (!text) return [] as unknown as T
  try {
    return JSON.parse(text) as T
  } catch {
    return [] as unknown as T
  }
}

/** Mailcow answers mutations with an envelope array; surface a usable result. */
function envelope(res: unknown): { success: boolean; error?: string } {
  const arr = Array.isArray(res) ? res : [res]
  const ok = arr.some(
    (e) => String((e as { type?: string })?.type || '').toLowerCase() === 'success'
  )
  if (ok) return { success: true }
  const msg = arr
    .map((e) => {
      const m = (e as { msg?: unknown })?.msg
      if (Array.isArray(m)) return m.join(' ')
      if (typeof m === 'string') return m
      return m ? JSON.stringify(m) : ''
    })
    .filter(Boolean)
    .join('; ')
  return { success: false, error: msg || 'The mail server rejected the request' }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const norm = (s: string) => (s || '').trim().toLowerCase()

/** True when an address (or @domain catch-all) belongs to the caller. */
function ownsAddress(address: string, domains: string[]): boolean {
  const a = norm(address)
  const at = a.lastIndexOf('@')
  if (at === -1) return false
  return domains.includes(a.slice(at + 1))
}

// ─── Aliases / forwarding / catch-all ──────────────────────────────────────

export interface MailAlias {
  id: number
  address: string
  /** comma-separated destinations as Mailcow stores them */
  goto: string
  destinations: string[]
  active: boolean
  /** an alias whose local part is empty (`@domain`) catches everything */
  isCatchAll: boolean
  domain: string
  createdAt?: string
}

interface RawAlias {
  id: number
  address: string
  goto: string
  active: number | string
  domain?: string
  created?: string
}

/** Every alias belonging to the caller's domains. */
export async function listAliases(domains: string[]): Promise<MailAlias[]> {
  const d = domains.map(norm)
  const raw = await mc<RawAlias[]>('/get/alias/all')
  if (!Array.isArray(raw)) return []
  return raw
    .filter((a) => a && a.address && ownsAddress(a.address, d))
    .map((a) => {
      const address = norm(a.address)
      const domain = address.slice(address.lastIndexOf('@') + 1)
      return {
        id: a.id,
        address,
        goto: a.goto || '',
        destinations: (a.goto || '').split(',').map((s) => s.trim()).filter(Boolean),
        active: String(a.active) === '1',
        isCatchAll: address.startsWith('@'),
        domain,
        createdAt: a.created,
      }
    })
}

export async function createAlias(
  address: string,
  destinations: string[],
  domains: string[],
  active = true
): Promise<{ success: boolean; error?: string }> {
  const a = norm(address)
  if (!ownsAddress(a, domains.map(norm))) {
    return { success: false, error: 'That address is not on one of your domains' }
  }
  if (destinations.length === 0) {
    return { success: false, error: 'At least one destination is required' }
  }
  const res = await mc('/add/alias', {
    method: 'POST',
    body: JSON.stringify({
      address: a,
      goto: destinations.map(norm).join(','),
      active: active ? '1' : '0',
    }),
  })
  return envelope(res)
}

export async function updateAlias(
  id: number,
  patch: { destinations?: string[]; active?: boolean },
  domains: string[]
): Promise<{ success: boolean; error?: string }> {
  // Re-read first: the id alone says nothing about ownership.
  const mine = await listAliases(domains)
  if (!mine.some((a) => a.id === id)) {
    return { success: false, error: 'Alias not found' }
  }
  const attr: Record<string, string> = {}
  if (patch.destinations) attr.goto = patch.destinations.map(norm).join(',')
  if (patch.active !== undefined) attr.active = patch.active ? '1' : '0'
  const res = await mc('/edit/alias', {
    method: 'POST',
    body: JSON.stringify({ items: [String(id)], attr }),
  })
  return envelope(res)
}

export async function deleteAlias(
  id: number,
  domains: string[]
): Promise<{ success: boolean; error?: string }> {
  const mine = await listAliases(domains)
  if (!mine.some((a) => a.id === id)) {
    return { success: false, error: 'Alias not found' }
  }
  const res = await mc('/delete/alias', {
    method: 'POST',
    body: JSON.stringify([String(id)]),
  })
  return envelope(res)
}

/** A catch-all is just an alias at `@domain`. */
export async function setCatchAll(
  domain: string,
  destination: string | null,
  domains: string[]
): Promise<{ success: boolean; error?: string }> {
  const d = norm(domain)
  if (!domains.map(norm).includes(d)) {
    return { success: false, error: 'That domain is not yours' }
  }
  const existing = (await listAliases(domains)).find((a) => a.address === `@${d}`)
  if (!destination) {
    if (!existing) return { success: true }
    return deleteAlias(existing.id, domains)
  }
  if (existing) {
    return updateAlias(existing.id, { destinations: [destination], active: true }, domains)
  }
  const res = await mc('/add/alias', {
    method: 'POST',
    body: JSON.stringify({ address: `@${d}`, goto: norm(destination), active: '1' }),
  })
  return envelope(res)
}

// ─── Spam policy ───────────────────────────────────────────────────────────

export interface SpamPolicy {
  /** e.g. "8,15" — greylist/reject thresholds */
  score: string
  whitelist: Array<{ prefid: number; value: string }>
  blacklist: Array<{ prefid: number; value: string }>
}

interface RawPolicy {
  prefid?: number
  object?: string
  value?: string
}

async function listPolicy(
  kind: 'wl' | 'bl',
  domains: string[]
): Promise<Array<{ prefid: number; value: string }>> {
  const out: Array<{ prefid: number; value: string }> = []
  for (const d of domains.map(norm)) {
    const raw = await mc<RawPolicy[]>(
      `/get/policy_${kind}_domain/${encodeURIComponent(d)}`
    ).catch(() => [])
    if (Array.isArray(raw)) {
      for (const r of raw) {
        if (r?.value) out.push({ prefid: Number(r.prefid), value: r.value })
      }
    }
  }
  return out
}

export async function getSpamPolicy(domains: string[]): Promise<SpamPolicy> {
  const [score, whitelist, blacklist] = await Promise.all([
    mc<{ score?: string }>('/get/spam-score/all').catch(() => ({ score: '' })),
    listPolicy('wl', domains),
    listPolicy('bl', domains),
  ])
  return { score: score?.score || '', whitelist, blacklist }
}

export async function addPolicy(
  kind: 'wl' | 'bl',
  domain: string,
  value: string,
  domains: string[]
): Promise<{ success: boolean; error?: string }> {
  const d = norm(domain)
  if (!domains.map(norm).includes(d)) {
    return { success: false, error: 'That domain is not yours' }
  }
  const res = await mc('/add/domain-policy', {
    method: 'POST',
    body: JSON.stringify({
      domain: d,
      object_list: kind === 'wl' ? 'wl' : 'bl',
      object_from: norm(value),
    }),
  })
  return envelope(res)
}

export async function deletePolicy(
  kind: 'wl' | 'bl',
  prefid: number,
  domains: string[]
): Promise<{ success: boolean; error?: string }> {
  const mine = await listPolicy(kind, domains)
  if (!mine.some((p) => p.prefid === prefid)) {
    return { success: false, error: 'Entry not found' }
  }
  const res = await mc('/delete/domain-policy', {
    method: 'POST',
    body: JSON.stringify({ prefid: [String(prefid)] }),
  })
  return envelope(res)
}

// ─── Quarantine ────────────────────────────────────────────────────────────

export interface QuarantineItem {
  id: number
  subject: string
  sender: string
  recipient: string
  score: number
  createdAt: string
  type: string
}

interface RawQuarantine {
  id: number
  subject?: string
  sender?: string
  rcpt?: string
  score?: number | string
  created?: number | string
  qid?: string
  type?: string
}

export async function listQuarantine(domains: string[]): Promise<QuarantineItem[]> {
  const raw = await mc<RawQuarantine[]>('/get/quarantine/all').catch(() => [])
  if (!Array.isArray(raw)) return []
  const d = domains.map(norm)
  return raw
    .filter((q) => q?.rcpt && ownsAddress(q.rcpt, d))
    .map((q) => ({
      id: q.id,
      subject: q.subject || '(no subject)',
      sender: q.sender || '',
      recipient: norm(q.rcpt || ''),
      score: Number(q.score) || 0,
      createdAt: q.created ? new Date(Number(q.created) * 1000).toISOString() : '',
      type: q.type || 'spam',
    }))
}

/** Release a quarantined message to its recipient, or delete it. */
export async function quarantineAction(
  action: 'release' | 'delete',
  ids: number[],
  domains: string[]
): Promise<{ success: boolean; error?: string }> {
  const mine = await listQuarantine(domains)
  const allowed = new Set(mine.map((q) => q.id))
  const safe = ids.filter((i) => allowed.has(i))
  if (safe.length === 0) return { success: false, error: 'No matching messages' }
  const res =
    action === 'delete'
      ? await mc('/delete/qitem', {
          method: 'POST',
          body: JSON.stringify(safe.map(String)),
        })
      : await mc('/edit/qitem', {
          method: 'POST',
          body: JSON.stringify({ items: safe.map(String), attr: { action: 'release' } }),
        })
  return envelope(res)
}

// ─── Logs ──────────────────────────────────────────────────────────────────

export type LogKind = 'postfix' | 'dovecot' | 'rspamd-history' | 'sogo'

export interface MailLogEntry {
  time: string
  message: string
  priority?: string
}

/**
 * Recent mail-server log lines that mention one of the caller's domains.
 * Mailcow's logs are server-wide, so filtering is mandatory — an unfiltered
 * response would leak other tenants' mail activity.
 */
export async function getLogs(
  kind: LogKind,
  domains: string[],
  limit = 200
): Promise<MailLogEntry[]> {
  const raw = await mc<Array<Record<string, unknown>>>(
    `/get/logs/${kind}/${Math.min(Math.max(limit, 1), 1000)}`
  ).catch(() => [])
  if (!Array.isArray(raw)) return []
  const d = domains.map(norm)
  const out: MailLogEntry[] = []
  for (const r of raw) {
    const blob = JSON.stringify(r).toLowerCase()
    if (!d.some((dom) => blob.includes(dom))) continue
    const t = r.time as number | string | undefined
    out.push({
      time: t ? new Date(Number(t) * 1000).toISOString() : '',
      message: String(r.message ?? r.subject ?? JSON.stringify(r)).slice(0, 500),
      priority: r.priority ? String(r.priority) : undefined,
    })
  }
  return out
}

// ─── Dashboard statistics ──────────────────────────────────────────────────

export interface MailStats {
  mailboxes: number
  activeMailboxes: number
  suspendedMailboxes: number
  aliases: number
  quotaBytes: number
  usedBytes: number
  messages: number
  quarantined: number
  queued: number
  /** vmail volume usage on the server, when readable */
  serverDiskUsedPercent: number | null
}

interface RawMailbox {
  username?: string
  active?: number | string
  quota?: number
  quota_used?: number
  messages?: number
  domain?: string
}

export async function getMailStats(domains: string[]): Promise<MailStats> {
  const d = domains.map(norm)
  const [boxes, aliases, quarantine, queue, vmail] = await Promise.all([
    mc<RawMailbox[]>('/get/mailbox/all').catch(() => []),
    listAliases(domains).catch(() => []),
    listQuarantine(domains).catch(() => []),
    mc<unknown[]>('/get/mailq/all').catch(() => []),
    mc<{ used_percent?: string | number }>('/get/status/vmail').catch(
      () => ({}) as { used_percent?: string | number }
    ),
  ])

  const mine = (Array.isArray(boxes) ? boxes : []).filter(
    (b) => b?.username && ownsAddress(b.username, d)
  )
  const active = mine.filter((b) => String(b.active) === '1').length
  const pct = vmail?.used_percent
  return {
    mailboxes: mine.length,
    activeMailboxes: active,
    suspendedMailboxes: mine.length - active,
    aliases: aliases.length,
    quotaBytes: mine.reduce((s, b) => s + (Number(b.quota) || 0), 0),
    usedBytes: mine.reduce((s, b) => s + (Number(b.quota_used) || 0), 0),
    messages: mine.reduce((s, b) => s + (Number(b.messages) || 0), 0),
    quarantined: quarantine.length,
    queued: Array.isArray(queue) ? queue.length : 0,
    serverDiskUsedPercent:
      pct === undefined ? null : Number(String(pct).replace('%', '')) || null,
  }
}

// ─── Mailbox settings (quota / suspend / rename) ───────────────────────────

export async function updateMailbox(
  address: string,
  patch: { quotaMb?: number; active?: boolean; name?: string; password?: string },
  domains: string[]
): Promise<{ success: boolean; error?: string }> {
  const a = norm(address)
  if (!ownsAddress(a, domains.map(norm))) {
    return { success: false, error: 'That mailbox is not on one of your domains' }
  }
  const attr: Record<string, string> = {}
  if (patch.quotaMb !== undefined) attr.quota = String(Math.max(0, patch.quotaMb))
  if (patch.active !== undefined) attr.active = patch.active ? '1' : '0'
  if (patch.name !== undefined) attr.name = patch.name
  if (patch.password) {
    attr.password = patch.password
    attr.password2 = patch.password
  }
  if (Object.keys(attr).length === 0) return { success: true }
  const res = await mc('/edit/mailbox', {
    method: 'POST',
    body: JSON.stringify({ items: [a], attr }),
  })
  return envelope(res)
}
