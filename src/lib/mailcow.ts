/**
 * Mailcow email hosting API client.
 *
 * Used by:
 *  - #17 Mailcow Email Hosting integration
 *
 * API docs: https://mailcow.github.io/mailcow-dockerized-docs/api/
 *
 * Mailcow's REST API lives under `{base}/api/v1/`. It uses an `X-API-Key`
 * header for auth (not a Bearer token) and accepts JSON bodies. Mutation
 * endpoints (POST /add/..., POST /delete/...) return an envelope of the
 * shape `{ type: "success" | "danger" | "warning", msg: string[] | object }`,
 * while read endpoints (GET /get/...) usually return a JSON array (or an
 * empty array when nothing is found).
 *
 * When MAILCOW_API_URL and MAILCOW_API_KEY env vars are not set, the client
 * runs in DEMO MODE — every call returns a simulated success response so
 * the rest of the platform can be exercised without a real Mailcow server.
 */
import crypto from 'crypto'
import { spawn } from 'child_process'

interface MailcowConfig {
  /** Base URL, e.g. https://mail.example.com (no trailing /api/v1) */
  url: string
  /** API token */
  key: string
}

function getConfig(): MailcowConfig | null {
  const url = process.env.MAILCOW_API_URL
  const key = process.env.MAILCOW_API_KEY
  if (!url || !key) return null
  // Treat the .env.example placeholders as "not configured". A literal
  // "replace-with-…" key would otherwise read as real and make every Mailcow
  // call hit a non-existent server — or be reported to customers as working.
  if (/^replace-with/i.test(key) || url === 'https://mail.example.com') return null
  // Normalise: callers may include or omit the trailing /api/v1.
  const trimmed = url.replace(/\/+$/, '')
  return { url: trimmed, key }
}

/**
 * Returns true when a real Mailcow instance is configured (i.e. NOT demo mode).
 */
export function isMailcowConfigured(): boolean {
  return getConfig() !== null
}

/** Resolve the full API base path (always ends with /api/v1, no trailing slash). */
function apiBase(cfg: MailcowConfig): string {
  if (/\/api\/v\d+$/.test(cfg.url)) return cfg.url
  return `${cfg.url}/api/v1`
}

/**
 * Mailcow mutation envelope. `type` is one of "success", "danger", "warning".
 */
interface MailcowEnvelope {
  type?: string
  msg?: string[] | Record<string, unknown> | unknown[]
}

async function mailcowFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const cfg = getConfig()
  if (!cfg) throw new Error('Mailcow not configured')

  const res = await fetch(`${apiBase(cfg)}${path}`, {
    ...init,
    headers: {
      'X-API-Key': cfg.key,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Mailcow API ${res.status}: ${text}`)
  }

  if (res.status === 204) return [] as unknown as T
  return (await res.json()) as T
}

/** Inspect a Mailcow envelope and return `{ success, error }`. */
function envelopeResult(env: MailcowEnvelope | MailcowEnvelope[]): {
  success: boolean
  error?: string
} {
  const arr = Array.isArray(env) ? env : [env]
  const ok = arr.some((e) => (e?.type || '').toLowerCase() === 'success')
  if (ok) return { success: true }
  const messages = arr
    .map((e) => {
      const m = e?.msg
      if (Array.isArray(m)) return m.join(', ')
      if (typeof m === 'string') return m
      if (m && typeof m === 'object') return JSON.stringify(m)
      return ''
    })
    .filter(Boolean)
    .join('; ')
  return { success: false, error: messages || 'Mailcow request failed' }
}

/**
 * Read Mailcow's DKIM response.
 *
 * `/get/dkim/{domain}` returns a bare OBJECT (not an array, and not the
 * `{public, selector}` shape used elsewhere): `pubkey` is raw base64,
 * `dkim_txt` is the assembled record, `dkim_selector` is the selector.
 * Parsing it as an array silently yields "no key", which then looks like
 * DKIM was never generated.
 *
 * The same payload also carries `privkey`. Only the fields below are ever
 * lifted out of it, so the private key cannot leak into a response.
 */
function parseDkim(raw: unknown): InfoDomainDkim | undefined {
  const d = (Array.isArray(raw) ? raw[0] : raw) as
    | Record<string, unknown>
    | undefined
  if (!d || typeof d !== 'object') return undefined

  const txt = typeof d.dkim_txt === 'string' ? d.dkim_txt : ''
  const pub = typeof d.pubkey === 'string' ? d.pubkey : ''
  // Older shape used `public`; keep accepting it.
  const legacy = typeof d.public === 'string' ? d.public : ''
  const value = txt || legacy || (pub ? `v=DKIM1;k=rsa;t=s;s=email;p=${pub}` : '')
  if (!value) return undefined

  return {
    length: Number(d.length) || 2048,
    public: value,
    selector:
      (typeof d.dkim_selector === 'string' && d.dkim_selector) ||
      (typeof d.selector === 'string' && d.selector) ||
      'mail',
  }
}

// ---------------------------------------------------------------------------
// Demo-mode helpers
// ---------------------------------------------------------------------------

/**
 * Build a realistic-looking 2048-bit RSA DKIM public key string for demo
 * mode. We can't actually run a real RSA keygen cheaply inside the lib, but
 * we can emit a plausible-length base64 blob in the standard `v=DKIM1; k=rsa;
 * p=<base64>` form that Mailcow itself returns.
 */
function fakeDkimPublicKey(): string {
  // A 2048-bit RSA public key DER is ~270 bytes → ~360 base64 chars.
  // Generate a deterministic-ish but distinct blob per call.
  const bytes = crypto.randomBytes(270)
  const b64 = bytes.toString('base64').replace(/(.{64})/g, '$1\n').trim()
  return `v=DKIM1; k=rsa; t=s; s=email; p=${b64}`
}

// ---------------------------------------------------------------------------
// Domain operations
// ---------------------------------------------------------------------------

interface AddDomainOptions {
  domain: string
  description?: string
  mailboxes?: number // default 10
  aliases?: number // default 20
  quota?: number // default 1024 MB
}

interface AddDomainResult {
  success: boolean
  domainId?: string
  error?: string
}

/**
 * Add a domain to Mailcow so it can host mailboxes for it.
 * POST /api/v1/add/domain
 */
export async function addDomain(
  opts: AddDomainOptions
): Promise<AddDomainResult> {
  if (!isMailcowConfigured()) {
    // DEMO MODE - simulated success
    console.log('[mailcow] DEMO MODE: addDomain', opts.domain)
    return {
      success: true,
      domainId: `demo-domain-${opts.domain}`,
    }
  }

  try {
    const body = {
      domain: opts.domain,
      description: opts.description || '',
      aliases: opts.aliases ?? 20,
      mailboxes: opts.mailboxes ?? 10,
      // Mailcow requires defquota <= maxquota <= (domain) quota. Match defquota
      // to maxquota so adding a domain never trips defquota_exceeds_maxquota.
      defquota: opts.quota ?? 1024,
      maxquota: opts.quota ?? 1024,
      quota: (opts.quota ?? 1024) * (opts.mailboxes ?? 10),
      active: '1',
      rl_value: 0,
      rl_frame: 's',
      backupmx: '0',
      relayhost: 0,
      dkim_selector: 'mail',
      dkim_length: 2048,
      key_description: `Apsamo Panel DKIM for ${opts.domain}`,
    }
    const env = await mailcowFetch<MailcowEnvelope>('/add/domain', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const result = envelopeResult(env)
    return {
      success: result.success,
      domainId: result.success ? opts.domain : undefined,
      error: result.error,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface EditDomainOptions {
  domain: string
  /** How many mailboxes the domain may hold. */
  mailboxes?: number
  /** Per-mailbox quota ceiling, MB. */
  maxQuotaMB?: number
  /** Whole-domain quota, MB. Must be >= maxQuotaMB. */
  totalQuotaMB?: number
  /** false parks the domain: mail stops being accepted and logins fail. */
  active?: boolean
}

/**
 * Change an EXISTING domain's limits or activation.
 * POST /api/v1/edit/domain
 *
 * `add/domain` cannot be reused for this — Mailcow rejects it with
 * "domain_exists" — so upgrades, add-ons and suspension all come through here.
 * Unlike the delete endpoints (which take a bare array), edit really does take
 * the `{ items, attr }` envelope.
 */
export async function editDomain(
  opts: EditDomainOptions
): Promise<{ success: boolean; error?: string }> {
  if (!isMailcowConfigured()) {
    console.log('[mailcow] DEMO MODE: editDomain', opts.domain, opts)
    return { success: true }
  }

  const attr: Record<string, unknown> = {}
  if (opts.mailboxes !== undefined) attr.mailboxes = opts.mailboxes
  if (opts.maxQuotaMB !== undefined) {
    // defquota <= maxquota is enforced by Mailcow; keep them in step so a
    // raise never trips defquota_exceeds_maxquota.
    attr.maxquota = opts.maxQuotaMB
    attr.defquota = opts.maxQuotaMB
  }
  if (opts.totalQuotaMB !== undefined) {
    attr.quota = Math.max(opts.totalQuotaMB, opts.maxQuotaMB ?? 0)
  }
  if (opts.active !== undefined) attr.active = opts.active ? '1' : '0'
  if (Object.keys(attr).length === 0) return { success: true }

  try {
    const env = await mailcowFetch<MailcowEnvelope | MailcowEnvelope[]>(
      '/edit/domain',
      {
        method: 'POST',
        body: JSON.stringify({ items: [opts.domain], attr }),
      }
    )
    return envelopeResult(env)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

interface DomainInfo {
  domainName: string
  active: boolean
  backupmx: boolean
  relays: number
  /** Mailbox ceiling for the domain. */
  mailboxes: number
  /** Mailboxes that actually exist right now. */
  mailboxesUsed: number
  aliases: number
  /** Per-mailbox quota ceiling, BYTES (Mailcow reports bytes here). */
  quota: number
  /** Whole-domain quota ceiling, BYTES. */
  maxQuotaForDomain: number
  /** Quota allocated across the domain's mailboxes, BYTES. */
  quotaUsed: number
  dkim?: { length: number; public: string; selector: string }
}

interface GetDomainResult {
  success: boolean
  domain?: DomainInfo
  error?: string
}

/**
 * Get domain info, including DKIM if present.
 * GET /api/v1/get/domain/{domain}
 * GET /api/v1/get/dkim/{domain} (for the public key)
 */
export async function getDomain(domain: string): Promise<GetDomainResult> {
  if (!isMailcowConfigured()) {
    // DEMO MODE
    console.log('[mailcow] DEMO MODE: getDomain', domain)
    return {
      success: true,
      domain: {
        domainName: domain,
        active: true,
        backupmx: false,
        relays: 0,
        mailboxes: 10,
        mailboxesUsed: 1,
        aliases: 20,
        quota: 1024 * 1024 ** 2,
        maxQuotaForDomain: 10240 * 1024 ** 2,
        quotaUsed: 1024 * 1024 ** 2,
      },
    }
  }

  try {
    const arr = await mailcowFetch<unknown[]>(`/get/domain/${encodeURIComponent(domain)}`)
    const raw = Array.isArray(arr) ? arr[0] : arr
    if (!raw || typeof raw !== 'object') {
      return { success: false, error: 'Domain not found in Mailcow' }
    }
    const d = raw as Record<string, unknown>

    let dkim: InfoDomainDkim | undefined
    try {
      dkim = parseDkim(
        await mailcowFetch<unknown>(`/get/dkim/${encodeURIComponent(domain)}`)
      )
    } catch {
      // DKIM lookup is best-effort; ignore failures.
    }

    return {
      success: true,
      domain: {
        domainName: String(d.domain_name || d.domain || domain),
        active: String(d.active) === '1' || d.active === true,
        backupmx: String(d.backupmx) === '1' || d.backupmx === true,
        relays: Number(d.relay_unknown_recipients || d.relays || 0),
        // Mailcow's GET shape uses none of the names its POST bodies take:
        // reads are max_num_mboxes_for_domain / max_quota_for_* (in bytes),
        // writes are mailboxes / maxquota / quota (in MB). Don't unify them.
        mailboxes: Number(d.max_num_mboxes_for_domain ?? d.mailboxes ?? 0),
        mailboxesUsed: Number(d.mboxes_in_domain ?? 0),
        aliases: Number(d.max_num_aliases_for_domain ?? d.aliases ?? 0),
        quota: Number(d.max_quota_for_mbox ?? d.quota ?? 0),
        maxQuotaForDomain: Number(d.max_quota_for_domain ?? d.maxquota ?? 0),
        quotaUsed: Number(d.quota_used_in_domain ?? 0),
        dkim,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

type InfoDomainDkim = { length: number; public: string; selector: string }

interface GenerateDkimResult {
  success: boolean
  publicKey?: string
  selector?: string
  error?: string
}

/**
 * Generate (or retrieve) a DKIM keypair for a domain.
 * POST /api/v1/add/dkim  — generates a new key
 * GET  /api/v1/get/dkim/{domain} — returns the public key (already present)
 */
export async function generateDkim(
  domain: string,
  selector = 'mail'
): Promise<GenerateDkimResult> {
  if (!isMailcowConfigured()) {
    // DEMO MODE - return a realistic-looking 2048-bit RSA DKIM public key
    console.log('[mailcow] DEMO MODE: generateDkim', domain, selector)
    return {
      success: true,
      publicKey: fakeDkimPublicKey(),
      selector,
    }
  }

  try {
    // Try to fetch an existing key first. add/domain already generates one from
    // its dkim_selector/dkim_length fields, so for a freshly-provisioned domain
    // this normally hits and no /add/dkim call is needed.
    let publicKey: string | undefined
    try {
      const existing = parseDkim(
        await mailcowFetch<unknown>(`/get/dkim/${encodeURIComponent(domain)}`)
      )
      if (existing) {
        publicKey = existing.public
        selector = existing.selector || selector
      }
    } catch {
      // No existing key — generate below.
    }

    if (!publicKey) {
      // add/dkim takes `domains` (plural) and `key_size`; the add/domain field
      // names are rejected with dkim_domain_or_sel_invalid.
      const body = {
        domains: domain,
        dkim_selector: selector,
        key_size: 2048,
      }
      const env = await mailcowFetch<MailcowEnvelope>('/add/dkim', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const result = envelopeResult(env)
      if (!result.success) {
        return { success: false, error: result.error }
      }
      // Re-fetch to get the freshly-generated public key.
      const fresh = parseDkim(
        await mailcowFetch<unknown>(`/get/dkim/${encodeURIComponent(domain)}`)
      )
      publicKey = fresh?.public
      selector = fresh?.selector || selector
    }

    if (!publicKey) {
      return { success: false, error: 'DKIM generation succeeded but no public key returned' }
    }
    return { success: true, publicKey, selector }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// Mailbox operations
// ---------------------------------------------------------------------------

interface CreateMailboxOptions {
  localPart: string // e.g. "admin", "info", "support"
  domain: string
  password: string
  name: string // display name
  quota?: number // MB, default 1024
}

interface CreateMailboxResult {
  success: boolean
  mailboxId?: string
  error?: string
}

/**
 * Create a mailbox.
 * POST /api/v1/add/mailbox
 *
 * NOTE: callers should encrypt `password` with src/lib/encryption before
 * persisting it anywhere. The plaintext is only sent to Mailcow itself.
 */
export async function createMailbox(
  opts: CreateMailboxOptions
): Promise<CreateMailboxResult> {
  if (!isMailcowConfigured()) {
    // DEMO MODE
    console.log(
      '[mailcow] DEMO MODE: createMailbox',
      `${opts.localPart}@${opts.domain}`
    )
    return {
      success: true,
      mailboxId: `demo-mailbox-${opts.localPart}@${opts.domain}`,
    }
  }

  try {
    const body = {
      local_part: opts.localPart,
      domain: opts.domain,
      password: opts.password,
      password2: opts.password,
      name: opts.name,
      quota: opts.quota ?? 1024,
      active: '1',
      force_pw_update: '0',
      tls_enforce_in: '0',
      tls_enforce_out: '0',
    }
    const env = await mailcowFetch<MailcowEnvelope>('/add/mailbox', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const result = envelopeResult(env)
    return {
      success: result.success,
      mailboxId: result.success
        ? `${opts.localPart}@${opts.domain}`
        : undefined,
      error: result.error,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

interface MailboxInfo {
  address: string
  name: string
  active: boolean
  quota: number
  usedQuota: number
}

interface ListMailboxesResult {
  success: boolean
  mailboxes?: MailboxInfo[]
  error?: string
}

/**
 * List mailboxes for a domain.
 * GET /api/v1/get/mailbox/{domain}
 */
export async function listMailboxes(
  domain: string
): Promise<ListMailboxesResult> {
  if (!isMailcowConfigured()) {
    // DEMO MODE
    console.log('[mailcow] DEMO MODE: listMailboxes', domain)
    return {
      success: true,
      mailboxes: [
        {
          address: `admin@${domain}`,
          name: 'Administrator',
          active: true,
          quota: 1024,
          usedQuota: 12,
        },
      ],
    }
  }

  try {
    // MUST be /get/mailbox/all/{domain}. Mailcow reads /get/mailbox/{x} as a
    // single mailbox ADDRESS lookup, so passing a domain there matches nothing
    // and comes back {} — a silent empty list, not an error.
    const arr = await mailcowFetch<
      Array<Record<string, unknown>>
    >(`/get/mailbox/all/${encodeURIComponent(domain)}`)
    // Mailcow returns {} (not []) for a domain with no mailboxes — guard so we
    // never call .map on a non-array.
    const mailboxes: MailboxInfo[] = (Array.isArray(arr) ? arr : []).map((m) => ({
      address: String(m.username || m.address || ''),
      name: String(m.name || ''),
      active: String(m.active) === '1' || m.active === true,
      quota: Number(m.quota || 0),
      usedQuota: Number(m.quota_used || m.used_quota || 0),
    }))
    return { success: true, mailboxes }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface UpdateMailboxOptions {
  address: string
  /** New password. Omit to leave it unchanged. */
  password?: string
  name?: string
  /** Per-mailbox quota in MB. Callers must clamp this to the plan first. */
  quotaMB?: number
  /** false disables login and delivery without deleting stored mail. */
  active?: boolean
}

/**
 * Drop a user's cached credentials from Dovecot.
 *
 * Dovecot runs with `auth_cache_ttl = 5 mins`, so after a password change the
 * OLD password keeps working for up to five minutes — verified by real IMAP
 * logins: both old and new succeeded until the cache was flushed. For a
 * password reset after a compromise that window is the whole point of the
 * reset, so every password change flushes the entry.
 *
 * Best-effort by design: it shells out to the Dovecot container, and a panel
 * host without docker access should not fail the password change itself.
 */
async function flushDovecotAuthCache(address: string): Promise<void> {
  const container = process.env.MAILCOW_DOVECOT_CONTAINER || 'mailcowdockerized-dovecot-mailcow-1'
  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    try {
      // Arguments are passed as an argv array, never a shell string, so the
      // address cannot be interpreted as shell syntax.
      const child = spawn(
        'docker',
        ['exec', container, 'doveadm', 'auth', 'cache', 'flush', address],
        { stdio: ['ignore', 'ignore', 'ignore'] }
      )
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        done()
      }, 10_000)
      child.on('error', () => {
        clearTimeout(timer)
        done()
      })
      child.on('close', () => {
        clearTimeout(timer)
        done()
      })
    } catch {
      done()
    }
  })
}

/**
 * Change an existing mailbox.
 * POST /api/v1/edit/mailbox — takes the `{ items, attr }` envelope.
 *
 * Mailcow requires the confirmation field `password2` alongside `password`;
 * sending only `password` leaves the old one in place and still reports
 * success.
 */
export async function updateMailbox(
  opts: UpdateMailboxOptions
): Promise<{ success: boolean; error?: string }> {
  if (!isMailcowConfigured()) {
    console.log('[mailcow] DEMO MODE: updateMailbox', opts.address)
    return { success: true }
  }

  const attr: Record<string, unknown> = {}
  if (opts.password) {
    attr.password = opts.password
    attr.password2 = opts.password
  }
  if (opts.name !== undefined) attr.name = opts.name
  if (opts.quotaMB !== undefined) attr.quota = opts.quotaMB
  if (opts.active !== undefined) attr.active = opts.active ? '1' : '0'
  if (Object.keys(attr).length === 0) return { success: true }

  try {
    const env = await mailcowFetch<MailcowEnvelope | MailcowEnvelope[]>(
      '/edit/mailbox',
      {
        method: 'POST',
        body: JSON.stringify({ items: [opts.address], attr }),
      }
    )
    const result = envelopeResult(env)
    if (result.success && opts.password) {
      await flushDovecotAuthCache(opts.address)
    }
    return result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

interface DeleteMailboxResult {
  success: boolean
  error?: string
}

/**
 * Delete a mailbox by address.
 * POST /api/v1/delete/mailbox
 * Body: { items: ["admin@example.com"] }
 */
export async function deleteMailbox(
  address: string
): Promise<DeleteMailboxResult> {
  if (!isMailcowConfigured()) {
    // DEMO MODE
    console.log('[mailcow] DEMO MODE: deleteMailbox', address)
    return { success: true }
  }

  try {
    const env = await mailcowFetch<MailcowEnvelope>('/delete/mailbox', {
      method: 'POST',
      // Mailcow's delete endpoints take a BARE ARRAY of identifiers. Sending
      // { items: [...] } comes back "access_denied" while the HTTP call still
      // looks fine, so the delete silently never happened.
      body: JSON.stringify([address]),
    })
    const result = envelopeResult(env)
    // Same cache window as a password change: without this the deleted
    // address can still authenticate for up to five minutes.
    if (result.success) await flushDovecotAuthCache(address)
    return { success: result.success, error: result.error }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Remove a domain from Mailcow.
 * POST /api/v1/delete/domain
 * Body: { items: ["example.com"] }
 */
export async function removeDomain(
  domain: string
): Promise<{ success: boolean; error?: string }> {
  if (!isMailcowConfigured()) {
    // DEMO MODE
    console.log('[mailcow] DEMO MODE: removeDomain', domain)
    return { success: true }
  }

  try {
    const env = await mailcowFetch<MailcowEnvelope>('/delete/domain', {
      method: 'POST',
      // Bare array, not { items: [...] } — see deleteMailbox above.
      body: JSON.stringify([domain]),
    })
    const result = envelopeResult(env)
    return { success: result.success, error: result.error }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// Higher-level helpers
// ---------------------------------------------------------------------------

interface VerifyEmailSetupResult {
  success: boolean
  domainActive: boolean
  dkimConfigured: boolean
  mailboxCount: number
  smtpAccessible: boolean // best-effort check
  imapAccessible: boolean // best-effort check
  details: string[]
}

/**
 * Test/verify an email setup: checks that the domain exists in Mailcow, has
 * DKIM configured, and has at least one mailbox. The SMTP/IMAP accessibility
 * checks are best-effort TCP probes against the mail server hostname.
 */
export async function verifyEmailSetup(
  domain: string
): Promise<VerifyEmailSetupResult> {
  const details: string[] = []
  const host = process.env.MAIL_SERVER_HOSTNAME || ''

  if (!isMailcowConfigured()) {
    // DEMO MODE — pretend everything is green
    console.log('[mailcow] DEMO MODE: verifyEmailSetup', domain)
    details.push('DEMO MODE: simulated successful verification')
    return {
      success: true,
      domainActive: true,
      dkimConfigured: true,
      mailboxCount: 1,
      smtpAccessible: true,
      imapAccessible: true,
      details,
    }
  }

  let domainActive = false
  let dkimConfigured = false
  let mailboxCount = 0

  // 1) Domain present & active
  try {
    const d = await getDomain(domain)
    if (d.success && d.domain) {
      domainActive = d.domain.active
      details.push(
        domainActive
          ? `Domain ${domain} is active in Mailcow`
          : `Domain ${domain} exists but is inactive`
      )
      if (d.domain.dkim?.public) {
        dkimConfigured = true
        details.push(
          `DKIM configured (selector=${d.domain.dkim.selector}, length=${d.domain.dkim.length})`
        )
      } else {
        details.push('DKIM not configured for domain')
      }
    } else {
      details.push(`Domain ${domain} not found in Mailcow: ${d.error || 'unknown'}`)
    }
  } catch (err) {
    details.push(
      `Domain lookup failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // 2) Mailbox count
  try {
    const list = await listMailboxes(domain)
    if (list.success && list.mailboxes) {
      mailboxCount = list.mailboxes.length
      details.push(`Found ${mailboxCount} mailbox(es) for ${domain}`)
    } else {
      details.push(`Mailbox listing failed: ${list.error || 'unknown'}`)
    }
  } catch (err) {
    details.push(
      `Mailbox listing failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // 3) Best-effort SMTP/IMAP reachability probes
  let smtpAccessible = false
  let imapAccessible = false
  if (host) {
    const probes = await probeMailPorts(host)
    smtpAccessible = probes.smtp
    imapAccessible = probes.imap
    details.push(
      `SMTP ${host}:587 ${smtpAccessible ? 'reachable' : 'unreachable'}`
    )
    details.push(
      `IMAP ${host}:993 ${imapAccessible ? 'reachable' : 'unreachable'}`
    )
  } else {
    details.push('MAIL_SERVER_HOSTNAME not set — skipping SMTP/IMAP probes')
  }

  const success =
    domainActive && dkimConfigured && mailboxCount > 0 && smtpAccessible && imapAccessible
  return {
    success,
    domainActive,
    dkimConfigured,
    mailboxCount,
    smtpAccessible,
    imapAccessible,
    details,
  }
}

/**
 * Best-effort TCP connect probe to a mail server's SMTP and IMAP ports.
 * Uses Node's `net` module; timeouts at 5s so this never blocks for long.
 */
async function probeMailPorts(
  host: string
): Promise<{ smtp: boolean; imap: boolean }> {
  const net = await import('net')
  const probe = (port: number) =>
    new Promise<boolean>((resolve) => {
      const socket = new net.Socket()
      let settled = false
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(5000)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
      socket.connect(port, host)
    })
  const [smtp, imap] = await Promise.all([probe(587), probe(993)])
  return { smtp, imap }
}

interface MailServerInfo {
  imap: { host: string; port: 993; ssl: true }
  smtp: { host: string; port: 587; tls: true }
  webmail: string
  pop3?: { host: string; port: 995; ssl: true }
}

/**
 * Return the mail server connection info that email clients (Outlook,
 * Thunderbird, mobile mail apps, etc.) need to connect to a mailbox on this
 * domain. The hostname comes from `MAIL_SERVER_HOSTNAME`.
 */
export async function getMailServerInfo(
  _domain: string
): Promise<MailServerInfo> {
  const host = process.env.MAIL_SERVER_HOSTNAME || 'mail.example.com'
  // Derive the webmail URL from MAILCOW_API_URL when possible, falling back
  // to the conventional SOGo path under the mail server hostname.
  const cfg = getConfig()
  let webmail: string
  if (cfg) {
    webmail = cfg.url.replace(/\/api\/v\d+\/?$/, '') + '/SOGo'
  } else {
    webmail = `https://${host}/SOGo`
  }

  return {
    imap: { host, port: 993, ssl: true },
    smtp: { host, port: 587, tls: true },
    webmail,
    pop3: { host, port: 995, ssl: true },
  }
}
