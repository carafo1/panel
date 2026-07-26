/**
 * phpMyAdmin Single Sign-On (signon auth, docker-exec hand-off)
 * =============================================================
 *
 * How the hand-off works — this drives phpMyAdmin's own `auth_type = 'signon'`
 * mechanism (the same approach cPanel/Plesk use), with no login form:
 *
 *   1. Customer clicks "Open phpMyAdmin" in the panel.
 *   2. The panel verifies auth + database ownership (`resolveTenantDatabase`),
 *      then mints a random single-use token and writes a small ticket file
 *      DIRECTLY INTO the phpMyAdmin container via `docker exec`.
 *   3. The browser is sent to `https://pma.<domain>/signon.php?token=…`.
 *   4. signon.php reads that ticket, unlinks it (single use), checks the expiry,
 *      puts the credentials into phpMyAdmin's signon session, and redirects into
 *      the customer's own database.
 *
 * Why docker exec rather than an HTTP callback: the host firewall (ufw,
 * default-deny) blocks container→host traffic, and opening a port for this would
 * widen the attack surface. Writing the ticket through the docker socket keeps
 * the credentials entirely off the network — the same transport the rest of the
 * Database Studio already uses.
 *
 * Security properties:
 *   - Token is 256-bit random; the ticket is single-use and expires in 60s.
 *   - Credentials never appear in a URL, never reach the customer's browser, and
 *     never leave the host.
 *   - The ticket only exists inside the phpMyAdmin container's own /tmp.
 *   - Root DB credentials are never involved: the session is the tenant's own
 *     limited DB user, so MySQL itself enforces isolation.
 *   - Every hand-off is audited by the calling route.
 */
import crypto from 'crypto'
import { spawn } from 'child_process'

export interface PmaTicket {
  /** docker container name of the tenant's DB (phpMyAdmin dials this host) */
  host: string
  port: number
  database: string
  user: string
  password: string
  /** epoch ms — signon.php refuses anything older */
  expiresAt: number
}

/** Tickets live 60s: enough for a redirect, short enough to be safe. */
const TICKET_TTL_MS = 60_000

/** Directory inside the phpMyAdmin container where tickets are dropped. */
const SPOOL_DIR = '/tmp/pma-signon'

/** Name of the phpMyAdmin container to hand off to. */
export function pmaContainer(): string {
  return process.env.PMA_CONTAINER || 'apsamo-pma'
}

/**
 * Base URL of the phpMyAdmin service (e.g. https://pma.apsamo.com).
 * Falls back to `pma.<BRAND_DOMAIN>`.
 */
export function pmaBaseUrl(): string {
  const configured = process.env.PMA_URL
  if (configured) return configured.replace(/\/+$/, '')
  const brand = process.env.BRAND_DOMAIN || 'apsamo.com'
  return `https://pma.${brand}`
}

/** True when the integration is wired up enough to offer in the UI. */
export function isPmaConfigured(): boolean {
  return !!(process.env.PMA_URL || process.env.PMA_CONTAINER)
}

/**
 * Write the ticket into the phpMyAdmin container. Ticket JSON goes over stdin
 * (never argv), so credentials never appear in a process list. The file exists
 * only inside that container.
 *
 * Ownership matters for correctness, not just tidiness: PHP runs as www-data,
 * and `unlink()` needs write permission on the DIRECTORY. The spool is
 * therefore owned by www-data (mode 700) so signon.php can actually burn the
 * ticket after reading it — with a root-owned 755 directory the delete fails
 * silently and the token stays replayable until it expires.
 */
function writeTicket(token: string, ticket: PmaTicket): Promise<void> {
  const container = pmaContainer()
  const path = `${SPOOL_DIR}/${token}.json`
  // Prune anything stale on every hand-off so the spool can't accumulate.
  const script =
    `mkdir -p ${SPOOL_DIR} && chown www-data:www-data ${SPOOL_DIR} && chmod 700 ${SPOOL_DIR} && ` +
    `find ${SPOOL_DIR} -type f -mmin +5 -delete 2>/dev/null; ` +
    `cat > ${path} && chown www-data:www-data ${path} && chmod 600 ${path}`

  return new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'sh', '-c', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (e) => reject(new Error(`docker exec failed: ${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `Could not prepare the phpMyAdmin session (exit ${code}). ${stderr.trim().slice(0, 200)}`
          )
        )
    })
    child.stdin.end(JSON.stringify(ticket))
  })
}

/**
 * Mint a single-use SSO token for a resolved tenant database connection and
 * stage it in the phpMyAdmin container. Returns the URL to send the browser to.
 */
export async function createPmaSession(conn: {
  container: string
  port: number
  database: string
  user: string
  password: string
}): Promise<{ url: string; expiresAt: number }> {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = Date.now() + TICKET_TTL_MS
  await writeTicket(token, {
    host: conn.container,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    expiresAt,
  })
  return { url: `${pmaBaseUrl()}/signon.php?token=${token}`, expiresAt }
}
