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

interface DomainInfo {
  domainName: string
  active: boolean
  backupmx: boolean
  relays: number
  mailboxes: number
  aliases: number
  quota: number
  maxQuotaForDomain: number
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
        aliases: 20,
        quota: 1024,
        maxQuotaForDomain: 10240,
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
      const dkimArr = await mailcowFetch<
        Array<{ length?: number; public?: string; selector?: string }>
      >(`/get/dkim/${encodeURIComponent(domain)}`)
      const dkimRaw = Array.isArray(dkimArr) ? dkimArr[0] : undefined
      if (dkimRaw && dkimRaw.public) {
        dkim = {
          length: dkimRaw.length || 2048,
          public: dkimRaw.public,
          selector: dkimRaw.selector || 'mail',
        }
      }
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
        mailboxes: Number(d.mailboxes || 0),
        aliases: Number(d.aliases || 0),
        quota: Number(d.quota || 0),
        maxQuotaForDomain: Number(d.maxquota || d.max_quota || 0),
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
    // Try to fetch an existing key first.
    let publicKey: string | undefined
    try {
      const existing = await mailcowFetch<
        Array<{ public?: string; selector?: string; length?: number }>
      >(`/get/dkim/${encodeURIComponent(domain)}`)
      const first = Array.isArray(existing) ? existing[0] : undefined
      if (first?.public) {
        publicKey = first.public
        selector = first.selector || selector
      }
    } catch {
      // No existing key — generate below.
    }

    if (!publicKey) {
      const body = {
        domain,
        dkim_selector: selector,
        dkim_length: 2048,
        key_description: 'Apsamo Panel auto DKIM',
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
      const fresh = await mailcowFetch<
        Array<{ public?: string; selector?: string; length?: number }>
      >(`/get/dkim/${encodeURIComponent(domain)}`)
      const first = Array.isArray(fresh) ? fresh[0] : undefined
      publicKey = first?.public
      selector = first?.selector || selector
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
    const arr = await mailcowFetch<
      Array<Record<string, unknown>>
    >(`/get/mailbox/${encodeURIComponent(domain)}`)
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
