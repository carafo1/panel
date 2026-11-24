/**
 * Deploy safety rules
 * ===================
 *
 * Pure helpers (no database, no network, no shell) used by the deployer to
 * decide whether something a customer supplied is safe to hand to Docker or
 * git on a host shared with other tenants. Kept free of side effects so the
 * rules are unit-tested directly (tests/unit/deploy-safety.test.ts).
 *
 * The panel runs these commands as root. Anything the customer controls that
 * reaches `docker compose`, `docker rm` or `git clone` is therefore a path to
 * the host or to another tenant unless it is checked here.
 */
import path from 'path'
import { isBlockedAddress } from '../ssrf'

// ─── Shell / regex quoting ──────────────────────────────────────────────

export function shellQuoteArg(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Escape a string so it matches itself literally inside a regular expression. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Container / compose project naming ─────────────────────────────────

/**
 * The project name `docker compose` derives from a directory, mirroring
 * compose-go's NormalizeProjectName: lower-case, keep [a-z0-9_-], trim
 * leading `_`/`-`.
 */
export function composeProjectName(deployPath: string): string {
  const base = path.posix.basename(deployPath.replace(/\/+$/, ''))
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[_-]+/, '')
}

/**
 * Environment prefix for every `docker compose` the panel runs on a host.
 *
 * On a localhost server the shell inherits the panel's own process.env —
 * JWT_SECRET, ENCRYPTION_KEY, DATABASE_URL — and compose interpolates
 * `${VAR}` in compose files from it, so a customer compose file (or an env
 * value) referencing `${ENCRYPTION_KEY}` received the panel's key. `env -i`
 * keeps only what the docker CLI needs to find its daemon and plugins.
 *
 * Shared by the deployer, the pipeline runner and the migration runner so the
 * three cannot drift. Ends with a space; prepend it to the command.
 */
/**
 * Run (from inside the deploy path) before any `docker compose up` / `run`.
 *
 * SECURITY: the generated compose files bind-mount ./wp-content,
 * ./wp-config-docker.php and ./db-data from the customer's own folder, and
 * Docker resolves a symlinked bind source ON THE HOST when it creates the
 * container. A customer who replaced one of them with a link (to /, /etc or
 * another customer's site) got that host path mounted into their container —
 * and the MariaDB image chowns its data dir. Links are refused here, and SFTP
 * cannot create links (internal-sftp -P symlink,hardlink). Ends with " && ".
 */
export const BIND_SOURCE_GUARD =
  'for p in ./site ./wp-content ./wp-config-docker.php ./db-data; do ' +
  'if [ -L "$p" ]; then echo "Refusing to start: $p is a link. Replace it with a real folder or file." >&2; exit 97; fi; ' +
  'done && '

export const COMPOSE_ENV =
  'env -i PATH="$PATH" HOME="$HOME" ' +
  '${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} ' +
  '${DOCKER_CONFIG:+DOCKER_CONFIG="$DOCKER_CONFIG"} ' +
  '${DOCKER_CONTEXT:+DOCKER_CONTEXT="$DOCKER_CONTEXT"} '

/**
 * `-p <name> ` pinning the compose project to the one derived from the
 * project's directory. Without it a compose file's `name:` (or
 * COMPOSE_PROJECT_NAME in .env) chose the project — a customer could edit
 * their file to `name: <another tenant>` and have `down -v` on delete remove
 * that tenant's containers and volumes. Empty when no deploy path is known.
 */
export function composeProjectFlag(deployPath: string | null | undefined): string {
  const name = deployPath ? composeProjectName(deployPath) : ''
  return name ? `-p ${shellQuoteArg(name)} ` : ''
}

/**
 * A `docker ps --filter name=` value that matches exactly one container name.
 *
 * Docker's name filter is an unanchored regular expression, and it is matched
 * against the name with its leading slash. `^deployhub-shop` therefore also
 * matched `deployhub-shop-online` — another tenant's site.
 */
export function exactContainerNameFilter(name: string): string {
  return `name=^/?${escapeRegex(name)}$`
}

/**
 * Shell command that force-removes a project's sibling containers (for
 * example a WordPress database started from the same compose file).
 *
 * Siblings are selected by the compose project label, which Docker matches as
 * an exact value, plus the exact container name. Nothing here is a prefix
 * match, so no other slug can be caught by it. Returns null when there is no
 * safe selector at all.
 */
export function siblingContainerCleanupCommand(
  containerName: string,
  composeProject: string
): string | null {
  const selectors: string[] = []
  if (composeProject && /^[a-z0-9][a-z0-9_-]*$/.test(composeProject)) {
    selectors.push(
      `docker ps -aq --filter ${shellQuoteArg(`label=com.docker.compose.project=${composeProject}`)}`
    )
  }
  if (containerName) {
    selectors.push(`docker ps -aq --filter ${shellQuoteArg(exactContainerNameFilter(containerName))}`)
  }
  if (selectors.length === 0) return null
  return `{ ${selectors.join('; ')}; } | sort -u | xargs -r docker rm -f 2>&1 || true`
}

// ─── Git remotes ────────────────────────────────────────────────────────

const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f-\u009f]/

function isForbiddenGitHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  // IP literals must be public. Names are not resolved here (no network in a
  // validator); the clone itself runs on the VPS, not inside the panel.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) {
    return isBlockedAddress(h)
  }
  return false
}

/**
 * A repository URL the customer may store on a project: `https://…` or the
 * scp-style `git@host:owner/repo`. Everything else — `file://`, a bare path
 * such as `/opt/deployhub/projects/<another tenant>`, `ext::` transports,
 * option-looking values — would let git read the host's own disk.
 */
export function validateGitUrl(
  raw: unknown
): { ok: true; url: string } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error })
  if (typeof raw !== 'string') return fail('Repository URL is required')
  const url = raw.trim()
  if (!url) return fail('Repository URL is required')
  if (url.length > 2048) return fail('Repository URL is too long')
  if (CONTROL_OR_SPACE.test(url)) return fail('Repository URL must not contain spaces or control characters')
  if (url.startsWith('-')) return fail('Repository URL must not start with "-"')

  if (/^https:\/\//i.test(url)) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return fail('Repository URL is not a valid https:// URL')
    }
    if (u.protocol !== 'https:') return fail('Repository URL must use https://')
    if (isForbiddenGitHost(u.hostname)) {
      return fail('Repository URL must point to a public git host')
    }
    return { ok: true, url }
  }

  const scp = url.match(/^git@([A-Za-z0-9][A-Za-z0-9.-]{0,252}):(.+)$/)
  if (scp) {
    const [, host, repoPath] = scp
    if (isForbiddenGitHost(host)) return fail('Repository URL must point to a public git host')
    if (repoPath.startsWith('-')) return fail('Repository path must not start with "-"')
    return { ok: true, url }
  }

  return fail('Repository URL must be an https:// or git@host:owner/repo address')
}

/**
 * Defence in depth for the clone itself: refuse anything git would treat as
 * a local repository or a helper transport, even if a row predates the
 * create-time check. Plain http:// is still accepted here because the project
 * PATCH endpoint has historically allowed it.
 */
export function isRemoteGitUrl(raw: string | null | undefined): boolean {
  if (!raw) return false
  const url = raw.trim()
  if (!url || url.startsWith('-') || CONTROL_OR_SPACE.test(url)) return false
  if (/^https?:\/\//i.test(url) || /^ssh:\/\//i.test(url)) {
    try {
      const u = new URL(url)
      return !isForbiddenGitHost(u.hostname)
    } catch {
      return false
    }
  }
  const scp = url.match(/^git@([A-Za-z0-9][A-Za-z0-9.-]{0,252}):(.+)$/)
  return !!scp && !isForbiddenGitHost(scp[1]) && !scp[2].startsWith('-')
}

/** A branch name safe to pass to git as an argument (never an option). */
export function isSafeGitBranch(branch: string): boolean {
  return (
    !!branch &&
    branch.length <= 255 &&
    !branch.startsWith('-') &&
    !CONTROL_OR_SPACE.test(branch) &&
    !branch.includes('..')
  )
}

// ─── Compose file validation ────────────────────────────────────────────

export interface ComposeCheckOptions {
  /** Absolute project directory on the host (the deploy path). */
  projectDir: string
  /** Compose project name the panel expects (see composeProjectName). */
  projectName: string
  /** The single host port assigned to this project. */
  hostPort: number
  /**
   * The one `container_name` that may appear (the panel's own generated
   * files set it). Customer compose files may not name containers at all.
   */
  allowedContainerName?: string | null
}

export interface ComposeCheckResult {
  errors: string[]
  /**
   * Host paths the model reads or mounts. All are inside projectDir
   * textually; the caller must still resolve symlinks on the host.
   */
  hostPaths: string[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

function nonEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (isObj(v)) return Object.keys(v).length > 0
  return true
}

function isInside(dir: string, p: string): boolean {
  const base = path.posix.normalize(dir).replace(/\/+$/, '')
  const target = path.posix.normalize(p)
  return target === base || target.startsWith(base + '/')
}

function resolveIn(dir: string, p: string): string {
  return path.posix.isAbsolute(p) ? path.posix.normalize(p) : path.posix.join(dir, p)
}

const SERVICE_DENY_NONEMPTY = [
  'cap_add',
  'devices',
  'device_cgroup_rules',
  'security_opt',
  'gpus',
  'external_links',
  'cgroup_parent',
  'userns_mode',
  'runtime',
  'provider',
] as const

/**
 * Validate a compose model as printed by `docker compose config --format
 * json`. That output is what compose will actually run — overrides merged,
 * anchors expanded, variables interpolated, relative paths made absolute —
 * so checking it is far harder to dodge than checking the YAML text.
 */
export function checkComposeModel(model: unknown, opts: ComposeCheckOptions): ComposeCheckResult {
  const errors: string[] = []
  const hostPaths: string[] = []
  const dir = path.posix.normalize(opts.projectDir).replace(/\/+$/, '')

  const pathInside = (where: string, raw: unknown) => {
    if (typeof raw !== 'string' || !raw) return
    const p = resolveIn(dir, raw)
    if (!isInside(dir, p)) {
      errors.push(`${where}: "${raw}" is outside the project directory`)
    } else {
      hostPaths.push(p)
    }
  }

  if (!isObj(model)) {
    return { errors: ['The compose configuration could not be read'], hostPaths }
  }

  if (typeof model.name === 'string' && model.name !== opts.projectName) {
    errors.push(
      `The compose project name must be "${opts.projectName}" (got "${model.name}"). Remove "name:" or COMPOSE_PROJECT_NAME.`
    )
  }
  if (nonEmpty(model.include)) errors.push('"include" is not supported')

  const services = isObj(model.services) ? model.services : {}
  const serviceNames = new Set(Object.keys(services))
  if (serviceNames.size === 0) errors.push('The compose file defines no services')

  const sameProjectRef = (v: string, prefix: string) =>
    v.startsWith(prefix) && serviceNames.has(v.slice(prefix.length))

  for (const [name, raw] of Object.entries(services)) {
    const at = `services.${name}`
    if (!isObj(raw)) continue
    const s = raw

    if (s.privileged) errors.push(`${at}: privileged containers are not allowed`)
    if (s.use_api_socket) errors.push(`${at}: access to the Docker API socket is not allowed`)
    for (const k of SERVICE_DENY_NONEMPTY) {
      if (nonEmpty(s[k])) errors.push(`${at}: "${k}" is not allowed`)
    }

    if (s.container_name !== undefined && s.container_name !== null && s.container_name !== '') {
      if (!opts.allowedContainerName || s.container_name !== opts.allowedContainerName) {
        errors.push(`${at}: "container_name" is not allowed — the panel names containers itself`)
      }
    }

    const nm = s.network_mode
    if (nm !== undefined && nm !== null && nm !== '') {
      const v = String(nm)
      if (!['bridge', 'none', 'default'].includes(v) && !sameProjectRef(v, 'service:')) {
        errors.push(`${at}: network_mode "${v}" is not allowed`)
      }
    }
    if (s.pid !== undefined && s.pid !== null && s.pid !== '') {
      if (!sameProjectRef(String(s.pid), 'service:')) errors.push(`${at}: pid "${String(s.pid)}" is not allowed`)
    }
    if (s.ipc !== undefined && s.ipc !== null && s.ipc !== '') {
      const v = String(s.ipc)
      if (!['private', 'shareable', 'none'].includes(v) && !sameProjectRef(v, 'service:')) {
        errors.push(`${at}: ipc "${v}" is not allowed`)
      }
    }
    if (nonEmpty(s.uts)) errors.push(`${at}: uts "${String(s.uts)}" is not allowed`)
    if (s.cgroup !== undefined && s.cgroup !== null && s.cgroup !== '' && s.cgroup !== 'private') {
      errors.push(`${at}: cgroup "${String(s.cgroup)}" is not allowed`)
    }

    if (Array.isArray(s.volumes_from)) {
      for (const v of s.volumes_from) {
        if (typeof v === 'string' && v.startsWith('container:')) {
          errors.push(`${at}: volumes_from "${v}" refers to a container outside this project`)
        }
      }
    }

    const labelKeys = Array.isArray(s.labels)
      ? s.labels.map((l) => String(l).split('=')[0])
      : isObj(s.labels)
        ? Object.keys(s.labels)
        : []
    for (const k of labelKeys) {
      if (k.startsWith('com.docker.compose.')) errors.push(`${at}: label "${k}" is reserved`)
    }

    // Lifecycle hooks can request privileges of their own.
    for (const hookKey of ['post_start', 'pre_stop']) {
      const hooks = s[hookKey]
      if (Array.isArray(hooks) && hooks.some((h) => isObj(h) && h.privileged)) {
        errors.push(`${at}: privileged ${hookKey} hooks are not allowed`)
      }
    }

    if (isObj(s.deploy) && isObj(s.deploy.resources) && isObj(s.deploy.resources.reservations)) {
      if (nonEmpty(s.deploy.resources.reservations.devices)) {
        errors.push(`${at}: device reservations are not allowed`)
      }
    }

    // Volumes: named volumes and tmpfs are fine; host paths only inside the project.
    if (Array.isArray(s.volumes)) {
      for (const v of s.volumes) {
        if (typeof v === 'string') {
          const src = v.split(':')[0]
          if (src.startsWith('/') || src.startsWith('.') || src.startsWith('~')) {
            if (src.startsWith('~')) errors.push(`${at}: volume "${v}" uses a home-directory path`)
            else pathInside(`${at}.volumes`, src)
          }
          continue
        }
        if (!isObj(v)) continue
        const type = String(v.type ?? 'volume')
        if (type === 'bind') {
          if (typeof v.source !== 'string' || !v.source) {
            errors.push(`${at}: bind mount without a source`)
          } else {
            pathInside(`${at}.volumes`, v.source)
          }
        } else if (type === 'volume') {
          if (typeof v.source === 'string' && v.source.includes('/')) {
            errors.push(`${at}: volume source "${v.source}" is not a named volume`)
          }
        } else if (type !== 'tmpfs' && type !== 'image') {
          errors.push(`${at}: volume type "${type}" is not allowed`)
        }
      }
    }

    // Ports: only the assigned host port may be published.
    if (Array.isArray(s.ports)) {
      for (const p of s.ports) {
        let published: string | undefined
        if (isObj(p)) {
          published =
            p.published === undefined || p.published === null || p.published === ''
              ? undefined
              : String(p.published)
        } else if (typeof p === 'string' || typeof p === 'number') {
          const parts = String(p).replace(/\/(tcp|udp|sctp)$/i, '').split(':')
          published = parts.length >= 2 ? parts[parts.length - 2] : undefined
        }
        if (published === undefined) {
          errors.push(`${at}: port ${JSON.stringify(p)} publishes a random host port; publish only ${opts.hostPort}`)
        } else if (published !== String(opts.hostPort)) {
          errors.push(`${at}: host port ${published} is not allowed; this site may publish only ${opts.hostPort}`)
        }
      }
    }

    if (Array.isArray(s.env_file)) {
      for (const e of s.env_file) {
        pathInside(`${at}.env_file`, typeof e === 'string' ? e : isObj(e) ? e.path : undefined)
      }
    } else if (typeof s.env_file === 'string') {
      pathInside(`${at}.env_file`, s.env_file)
    }

    // Build: the context and Dockerfile must come from the project itself.
    const b = s.build
    let context: string | null = null
    if (typeof b === 'string') {
      context = b
    } else if (isObj(b)) {
      context = typeof b.context === 'string' ? b.context : '.'
      if (b.network !== undefined && b.network !== null && b.network !== '' && b.network !== 'default' && b.network !== 'none') {
        errors.push(`${at}: build network "${String(b.network)}" is not allowed`)
      }
      if (nonEmpty(b.ssh)) errors.push(`${at}: build ssh forwarding is not allowed`)
      if (b.privileged) errors.push(`${at}: privileged builds are not allowed`)
      if (nonEmpty(b.entitlements)) errors.push(`${at}: build entitlements are not allowed`)
      if (nonEmpty(b.cache_to)) errors.push(`${at}: build cache_to is not allowed`)
      if (Array.isArray(b.cache_from) && b.cache_from.some((c) => /type\s*=\s*local/i.test(String(c)))) {
        errors.push(`${at}: a local build cache source is not allowed`)
      }
      if (isObj(b.additional_contexts)) {
        for (const [k, v] of Object.entries(b.additional_contexts)) {
          const val = String(v)
          if (/^(docker-image|service|oci-layout):/.test(val)) {
            if (val.startsWith('oci-layout:')) errors.push(`${at}: build context "${k}" uses a host OCI layout`)
            continue
          }
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(val) || val.startsWith('git@')) continue
          pathInside(`${at}.build.additional_contexts.${k}`, val)
        }
      }
    }
    if (context !== null) {
      const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(context) || context.startsWith('git@')
      if (!remote) {
        pathInside(`${at}.build.context`, context)
        if (isObj(b) && typeof b.dockerfile === 'string' && b.dockerfile) {
          pathInside(`${at}.build.dockerfile`, resolveIn(resolveIn(dir, context), b.dockerfile))
        }
      }
    }
  }

  if (isObj(model.volumes)) {
    for (const [name, v] of Object.entries(model.volumes)) {
      if (!isObj(v)) continue
      if (v.external) errors.push(`volumes.${name}: external volumes are not allowed`)
      if (v.driver !== undefined && v.driver !== null && v.driver !== '' && v.driver !== 'local') {
        errors.push(`volumes.${name}: volume driver "${String(v.driver)}" is not allowed`)
      }
      if (nonEmpty(v.driver_opts)) errors.push(`volumes.${name}: driver_opts are not allowed`)
    }
  }

  if (isObj(model.networks)) {
    for (const [name, n] of Object.entries(model.networks)) {
      if (!isObj(n)) continue
      const realName = typeof n.name === 'string' ? n.name : name
      if (n.external && realName !== 'deployhub') {
        errors.push(`networks.${name}: only the "deployhub" network may be external`)
      }
      if (n.driver !== undefined && n.driver !== null && n.driver !== '' && n.driver !== 'bridge') {
        errors.push(`networks.${name}: network driver "${String(n.driver)}" is not allowed`)
      }
      if (nonEmpty(n.driver_opts)) errors.push(`networks.${name}: driver_opts are not allowed`)
    }
  }

  for (const section of ['secrets', 'configs'] as const) {
    const sec = model[section]
    if (!isObj(sec)) continue
    for (const [name, v] of Object.entries(sec)) {
      if (!isObj(v)) continue
      if (v.external) errors.push(`${section}.${name}: external ${section} are not allowed`)
      if (typeof v.file === 'string') pathInside(`${section}.${name}.file`, v.file)
    }
  }

  return { errors, hostPaths: [...new Set(hostPaths)] }
}

/**
 * Checks on the compose file TEXT for features that read other files on the
 * host before the model is printed: `include`, `extends` from another file,
 * and `env_file` paths. The printed model has already merged those in, so
 * their origin is no longer visible there.
 *
 * Deliberately conservative: a false rejection costs one edit to the
 * customer's file; a false acceptance can hand them another tenant's config.
 */
export function scanComposeText(text: string): { errors: string[]; envFiles: string[] } {
  const errors: string[] = []
  const envFiles: string[] = []
  const lines = text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, ''))
  const body = lines.join('\n')
  const key = (k: string) => new RegExp(`(^|[\\s{,\\-])["']?${k}["']?[ \\t]*:`, 'm')

  if (key('include').test(body)) {
    errors.push('"include" is not supported — keep the whole configuration in one compose file')
  }
  if (key('extends').test(body) && key('file').test(body)) {
    errors.push('"extends" from another file is not supported')
  }

  const clean = (v: string) => v.trim().replace(/^["']|["']$/g, '').trim()
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s*)?["']?env_file["']?\s*:\s*(.*)$/)
    if (!m) continue
    const indent = m[1].length
    const inline = m[2].trim()
    if (inline) {
      const flow = inline.startsWith('[') ? inline.replace(/^\[|\]$/g, '').split(',') : [inline]
      for (const f of flow) if (clean(f)) envFiles.push(clean(f))
    }
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim()) continue
      const ind = l.length - l.trimStart().length
      if (ind <= indent && !l.trimStart().startsWith('-')) break
      if (ind < indent) break
      const item = l.trim().replace(/^-\s*/, '')
      const pm = item.match(/^["']?path["']?\s*:\s*(.+)$/)
      if (pm) envFiles.push(clean(pm[1]))
      else if (!/^[A-Za-z_]+\s*:/.test(item) && l.trim().startsWith('-')) envFiles.push(clean(item))
    }
  }
  for (const f of envFiles) {
    if (f.startsWith('/') || f.startsWith('~') || f.includes('$') || f.split(/[\\/]/).includes('..')) {
      errors.push(`env_file "${f}" must be a file inside the project`)
    }
  }
  return { errors, envFiles: [...new Set(envFiles)] }
}

/** Compose-related variables in a project's `.env` that would redirect compose elsewhere. */
export const DANGEROUS_COMPOSE_ENV_RE =
  /^[ \t]*(export[ \t]+)?(COMPOSE_FILE|COMPOSE_PROJECT_NAME|COMPOSE_ENV_FILES|COMPOSE_PATH_SEPARATOR)[ \t]*=/m

// ─── HTTP readiness ─────────────────────────────────────────────────────

/** Any real HTTP answer below 500 means the app is up and serving. */
export function isAcceptableHttpStatus(code: string | number): boolean {
  const n = typeof code === 'number' ? code : parseInt(String(code).trim(), 10)
  return Number.isInteger(n) && n >= 100 && n < 500
}

/**
 * Bash script that probes an upstream over HTTP until it answers with a
 * status below 500, or gives up. Prints `PROBE_OK <target> <code>` or
 * `PROBE_FAIL <detail>` and exits 0 / 1. Tries curl, then bash's /dev/tcp.
 */
export function httpProbeScript(opts: {
  hostPort: number
  containerName: string
  containerPort: number
  attempts?: number
  delaySec?: number
}): string {
  const attempts = Math.max(1, Math.min(opts.attempts ?? 10, 60))
  const delay = Math.max(1, Math.min(opts.delaySec ?? 3, 30))
  const name = shellQuoteArg(opts.containerName)
  const hp = Math.trunc(opts.hostPort)
  const cp = Math.trunc(opts.containerPort)
  return [
    `probe() {`,
    `  if command -v curl >/dev/null 2>&1; then`,
    `    curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$1/" 2>/dev/null`,
    `  else`,
    `    timeout 6 bash -c 'exec 3<>/dev/tcp/'"\${1%:*}"'/'"\${1##*:}"' && printf "GET / HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n" >&3 && head -c 64 <&3' 2>/dev/null | head -1 | awk '{print $2}'`,
    `  fi`,
    `}`,
    `IP=$(docker inspect -f '{{with index .NetworkSettings.Networks "deployhub"}}{{.IPAddress}}{{end}}' ${name} 2>/dev/null)`,
    `last="no response"`,
    `i=0`,
    `while [ $i -lt ${attempts} ]; do`,
    `  for t in "127.0.0.1:${hp}" \${IP:+"$IP:${cp}"}; do`,
    `    code=$(probe "$t")`,
    `    case "$code" in`,
    `      [1-4][0-9][0-9]) echo "PROBE_OK $t $code"; exit 0;;`,
    `      5[0-9][0-9]) last="$t answered HTTP $code";;`,
    `    esac`,
    `  done`,
    `  i=$((i+1))`,
    `  [ $i -lt ${attempts} ] && sleep ${delay}`,
    `done`,
    `echo "PROBE_FAIL $last"`,
    `exit 1`,
  ].join('\n')
}
