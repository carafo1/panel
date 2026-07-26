/**
 * pgAdmin 4 Single Sign-On + per-tenant provisioning
 * ==================================================
 *
 * pgAdmin has no phpMyAdmin-style "signon" endpoint, so SSO is done with its
 * **webserver authentication** source: pgAdmin trusts an identity header that
 * only the reverse proxy may set. The chain is:
 *
 *   1. Customer clicks "Open pgAdmin" in the panel.
 *   2. The panel verifies ownership, provisions the tenant inside pgAdmin
 *      (account + their server registrations + a libpq passfile), then mints a
 *      short-lived hand-off token and sends the browser to
 *      `https://pgadmin.<domain>/apsamo-sso?token=…`.
 *   3. Caddy routes that one path back to the panel, which validates the token
 *      and sets a session cookie scoped to the pgAdmin host.
 *   4. Every other request to pgAdmin passes through Caddy `forward_auth` to
 *      `/api/pgadmin/authorize`, which validates that cookie and returns the
 *      tenant's pgAdmin username. Caddy copies it upstream as `X-Remote-User`.
 *
 * Why the customer never sees a password:
 *   - pgAdmin auto-logs-in from the header (no pgAdmin login screen).
 *   - Each server is registered with a libpq `passfile`, so connecting to
 *     PostgreSQL needs no prompt either.
 *
 * Isolation is structural: pgAdmin scopes servers by `user_id`, so a tenant can
 * only ever see the servers registered to their own pgAdmin account, and those
 * are exactly the databases the panel registered for them.
 *
 * Tokens are AES-256-GCM encrypted (authenticated) via `@/lib/encryption`, so a
 * tampered or forged token fails to decrypt.
 */
import { spawn } from 'child_process'
import { encryptJSON, decryptJSON } from '@/lib/encryption'

// ─── Config ────────────────────────────────────────────────────────────────

/** Hand-off token: single redirect, so it only needs seconds of life. */
const HANDOFF_TTL_MS = 60_000
/** Session cookie lifetime — matches a typical admin working session. */
const SESSION_TTL_MS = 60 * 60 * 1000

export const PGADMIN_COOKIE = 'apsamo_pgadmin'

export function pgAdminContainer(): string {
  return process.env.PGADMIN_CONTAINER || 'apsamo-pgadmin'
}

export function pgAdminBaseUrl(): string {
  const configured = process.env.PGADMIN_URL
  if (configured) return configured.replace(/\/+$/, '')
  const brand = process.env.BRAND_DOMAIN || 'apsamo.com'
  return `https://pgadmin.${brand}`
}

export function isPgAdminConfigured(): boolean {
  return !!(process.env.PGADMIN_URL || process.env.PGADMIN_CONTAINER)
}

/**
 * The tenant's pgAdmin account name. pgAdmin's webserver auth keys accounts on
 * this string, so it must be stable for the life of the panel account — the
 * user id is used rather than the email, which can change.
 */
export function pgAdminUsernameFor(userId: string): string {
  return `u${userId}@apsamo.local`
}

/** pgAdmin's per-user storage directory name: '@' becomes '_'. */
function storageDirFor(username: string): string {
  return username.replace('@', '_')
}

// ─── Tokens ────────────────────────────────────────────────────────────────

interface TokenPayload {
  /** pgAdmin username */
  pu: string
  /** panel user id, for auditing */
  uid: string
  typ: 'handoff' | 'session'
  exp: number
}

const b64url = (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unB64url = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  return t + '='.repeat((4 - (t.length % 4)) % 4)
}

function mint(payload: Omit<TokenPayload, 'exp'>, ttlMs: number): string {
  return b64url(encryptJSON({ ...payload, exp: Date.now() + ttlMs }))
}

function verify(token: string, typ: TokenPayload['typ']): TokenPayload | null {
  try {
    const p = decryptJSON<TokenPayload>(unB64url(token))
    if (!p || p.typ !== typ) return null
    if (typeof p.exp !== 'number' || p.exp <= Date.now()) return null
    if (!p.pu) return null
    return p
  } catch {
    // Tampered, forged, or encrypted under a rotated key.
    return null
  }
}

export const mintHandoffToken = (pu: string, uid: string) =>
  mint({ pu, uid, typ: 'handoff' }, HANDOFF_TTL_MS)
export const verifyHandoffToken = (t: string) => verify(t, 'handoff')
export const mintSessionToken = (pu: string, uid: string) =>
  mint({ pu, uid, typ: 'session' }, SESSION_TTL_MS)
export const verifySessionToken = (t: string) => verify(t, 'session')

export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000)

// ─── Provisioning inside the pgAdmin container ─────────────────────────────

export interface PgServerSpec {
  /** display name in pgAdmin's tree */
  name: string
  /** docker container name of the tenant's postgres */
  host: string
  port: number
  database: string
  user: string
  password: string
}

/** Run a shell script inside the pgAdmin container, feeding stdin. */
function execInContainer(script: string, stdin = ''): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', '-i', pgAdminContainer(), 'sh', '-c', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', (e) => resolve({ ok: false, out: out + '\n' + e.message }))
    child.on('close', (code) => resolve({ ok: code === 0, out }))
    child.stdin.end(stdin)
  })
}

/**
 * Make a tenant's databases available in pgAdmin: ensure their account exists,
 * write the libpq passfile, register (replacing) their servers, and point each
 * server at that passfile.
 *
 * Idempotent — it runs on every "Open pgAdmin" click so pgAdmin always reflects
 * the databases the tenant currently owns, including ones added or removed
 * since their last visit.
 */
export async function provisionPgAdminTenant(
  username: string,
  servers: PgServerSpec[]
): Promise<{ ok: boolean; message: string }> {
  // The whole payload (including passwords) goes over stdin, never argv, so it
  // never appears in a process list.
  const payload = JSON.stringify({
    username,
    storage: `/var/lib/pgadmin/storage/${storageDirFor(username)}`,
    servers,
  })

  // pgAdmin's own `setup.py` CLI would be the obvious tool here, but each
  // invocation boots the full app and takes ~27s — far too slow for a
  // click-to-open flow, and `add-external-user` additionally fails without an
  // explicit role. Writing pgAdmin's SQLite directly does the same work in
  // ~20ms. The shapes below mirror exactly what pgAdmin's own auto-create
  // produces for a webserver-auth user.
  // The script is written to a file first rather than piped in as a heredoc:
  // `python - <<EOF` turns the heredoc into stdin, which would leave the JSON
  // payload unreadable.
  const script = `cat > /tmp/apsamo-prov.py <<'PY'
import json, os, sqlite3, sys, uuid

data = json.load(sys.stdin)
username = data['username']
storage = data['storage']
servers = data['servers']

# ── libpq passfile: one line per database, only readable by pgAdmin ──
os.makedirs(storage, exist_ok=True)
pgpass = os.path.join(storage, '.pgpass')
with open(pgpass, 'w') as f:
    for s in servers:
        f.write(f"{s['host']}:{s['port']}:{s['database']}:{s['user']}:{s['password']}\\n")
os.chmod(pgpass, 0o600)
try:
    import shutil
    shutil.chown(storage, user='pgadmin')
    shutil.chown(pgpass, user='pgadmin')
except Exception:
    pass

db = '/var/lib/pgadmin/pgadmin4.db'
for cand in ('/var/lib/pgadmin/pgadmin4.db', '/var/lib/pgadmin/config/pgadmin4.db'):
    if os.path.exists(cand):
        db = cand
        break
c = sqlite3.connect(db)

# ── account (same shape pgAdmin's webserver auto-create writes) ──
row = c.execute('select id from user where username = ?', (username,)).fetchone()
if row:
    uid = row[0]
else:
    uid = c.execute(
        'insert into user (email, password, active, username, auth_source,'
        ' fs_uniquifier, locked, login_attempts) values (NULL, NULL, 1, ?, ?, ?, 0, 0)',
        (username, 'webserver', uuid.uuid4().hex),
    ).lastrowid
    # role 2 = "pgAdmin User Role" (never Administrator).
    c.execute('insert into roles_users (user_id, role_id) values (?, 2)', (uid,))

grp = c.execute(
    'select id from servergroup where user_id = ? and name = ?', (uid, 'My Databases')
).fetchone()
gid = grp[0] if grp else c.execute(
    'insert into servergroup (user_id, name) values (?, ?)', (uid, 'My Databases')
).lastrowid

# ── servers: replaced wholesale so the tree always matches what the panel
# says the tenant owns (databases added or removed since last visit) ──
params = json.dumps({'sslmode': 'prefer', 'passfile': '/.pgpass', 'connect_timeout': 10})
c.execute('delete from server where user_id = ?', (uid,))
for s in servers:
    c.execute(
        'insert into server (user_id, servergroup_id, name, host, port, maintenance_db,'
        ' username, connection_params, shared) values (?, ?, ?, ?, ?, ?, ?, ?, 0)',
        (uid, gid, s['name'], s['host'], s['port'], s['database'], s['user'], params),
    )
c.commit()
print('APSAMO_PROVISION_OK uid=%s servers=%s' % (uid, len(servers)))
PY
/venv/bin/python /tmp/apsamo-prov.py
rc=$?
rm -f /tmp/apsamo-prov.py
exit $rc
`

  const r = await execInContainer(script, payload)
  if (!r.ok || !r.out.includes('APSAMO_PROVISION_OK')) {
    return {
      ok: false,
      message: `Could not prepare pgAdmin for this account: ${
        r.out.trim().slice(0, 300) || 'no output from pgAdmin container'
      }`,
    }
  }
  return { ok: true, message: 'pgAdmin session prepared' }
}
