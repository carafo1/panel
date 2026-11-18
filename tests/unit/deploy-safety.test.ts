/**
 * tests/unit/deploy-safety.test.ts — regression tests for the deployer's
 * hardening rules (src/lib/vps/deploy-safety.ts):
 *   - C1: container cleanup never prefix-matches another tenant's container
 *   - C2: customer compose models cannot reach the host or other tenants
 *   - git URL validation at create time (no local paths / file://)
 *   - HTTP readiness status rule
 */
import { describe, it, expect } from 'bun:test'
import {
  checkComposeModel,
  composeProjectName,
  escapeRegex,
  exactContainerNameFilter,
  httpProbeScript,
  isAcceptableHttpStatus,
  isRemoteGitUrl,
  isSafeGitBranch,
  scanComposeText,
  siblingContainerCleanupCommand,
  validateGitUrl,
  DANGEROUS_COMPOSE_ENV_RE,
} from '../../src/lib/vps/deploy-safety'

// ─── C1: container name filters ─────────────────────────────────────────

/** Apply a docker `name=` filter the way the daemon does (regex on "/name"). */
function dockerNameFilterMatches(filter: string, containerName: string): boolean {
  const re = new RegExp(filter.replace(/^name=/, ''))
  return re.test('/' + containerName) || re.test(containerName)
}

describe('container cleanup filters (C1)', () => {
  it('exact name filter matches the container itself', () => {
    expect(dockerNameFilterMatches(exactContainerNameFilter('deployhub-shop'), 'deployhub-shop')).toBe(true)
  })

  it('exact name filter does NOT match another tenant sharing the prefix', () => {
    const f = exactContainerNameFilter('deployhub-shop')
    expect(dockerNameFilterMatches(f, 'deployhub-shop-online')).toBe(false)
    expect(dockerNameFilterMatches(f, 'deployhub-shop-db')).toBe(false)
    expect(dockerNameFilterMatches(f, 'xdeployhub-shop')).toBe(false)
  })

  it('escapes regex metacharacters in names', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c')
    const f = exactContainerNameFilter('my.app')
    expect(dockerNameFilterMatches(f, 'my.app')).toBe(true)
    expect(dockerNameFilterMatches(f, 'myxapp')).toBe(false)
  })

  it('sibling cleanup selects by exact compose project label, never by prefix', () => {
    const cmd = siblingContainerCleanupCommand('deployhub-shop', 'shop')!
    expect(cmd).toContain('label=com.docker.compose.project=shop')
    expect(cmd).toContain(exactContainerNameFilter('deployhub-shop'))
    // The old, dangerous unanchored prefix form must be gone.
    expect(cmd).not.toContain('name=^deployhub-shop')
    expect(cmd).not.toContain("name=^'deployhub-shop'")
  })

  it('omits the label selector for an unusable project name', () => {
    const cmd = siblingContainerCleanupCommand('deployhub-x', '')!
    expect(cmd).not.toContain('label=')
    expect(siblingContainerCleanupCommand('', '')).toBeNull()
  })

  it('derives the compose project name like compose-go does', () => {
    expect(composeProjectName('/opt/deployhub/projects/shop')).toBe('shop')
    expect(composeProjectName('/opt/deployhub/projects/Shop.Online/')).toBe('shoponline')
    expect(composeProjectName('/x/_-weird')).toBe('weird')
  })
})

// ─── C2: compose model validation ───────────────────────────────────────

const DIR = '/opt/deployhub/projects/shop'
const OPTS = { projectDir: DIR, projectName: 'shop', hostPort: 30001 }

function svc(extra: Record<string, unknown>) {
  return {
    name: 'shop',
    services: {
      app: { image: 'nginx', ...extra },
    },
  }
}

describe('checkComposeModel (C2)', () => {
  it('accepts a normal app with the assigned port, named volumes and project binds', () => {
    const model = {
      name: 'shop',
      services: {
        app: {
          build: { context: DIR, dockerfile: 'Dockerfile' },
          ports: [{ mode: 'ingress', host_ip: '127.0.0.1', target: 80, published: '30001', protocol: 'tcp' }],
          volumes: [
            { type: 'bind', source: `${DIR}/wp-content`, target: '/var/www/html/wp-content' },
            { type: 'volume', source: 'data', target: '/data' },
            { type: 'tmpfs', target: '/tmp' },
          ],
          networks: { default: null, deployhub: null },
        },
        db: { image: 'mariadb:11', volumes: [{ type: 'volume', source: 'dbdata', target: '/var/lib/mysql' }] },
      },
      networks: { default: { name: 'shop_default' }, deployhub: { name: 'deployhub', external: true } },
      volumes: { data: { name: 'shop_data' }, dbdata: { name: 'shop_dbdata' } },
    }
    const res = checkComposeModel(model, OPTS)
    expect(res.errors).toEqual([])
    expect(res.hostPaths).toContain(`${DIR}/wp-content`)
    expect(res.hostPaths).toContain(DIR)
    expect(res.hostPaths).toContain(`${DIR}/Dockerfile`)
  })

  const rejected: Array<[string, Record<string, unknown>]> = [
    ['privileged', { privileged: true }],
    ['cap_add', { cap_add: ['SYS_ADMIN'] }],
    ['devices', { devices: [{ source: '/dev/sda', target: '/dev/sda' }] }],
    ['docker.sock bind', { volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] }],
    ['host root bind', { volumes: [{ type: 'bind', source: '/', target: '/host' }] }],
    ['../ bind (resolved)', { volumes: [{ type: 'bind', source: `${DIR}/../victim`, target: '/v' }] }],
    ['string ../ bind', { volumes: ['../victim:/v'] }],
    ['network_mode host', { network_mode: 'host' }],
    ['network_mode other container', { network_mode: 'container:deployhub-victim' }],
    ['pid host', { pid: 'host' }],
    ['ipc host', { ipc: 'host' }],
    ['uts host', { uts: 'host' }],
    ['userns_mode host', { userns_mode: 'host' }],
    ['security_opt', { security_opt: ['apparmor:unconfined'] }],
    ['container_name', { container_name: 'deployhub-victim' }],
    ['other host port', { ports: [{ target: 80, published: '22' }] }],
    ['random host port', { ports: [{ target: 80 }] }],
    ['string other host port', { ports: ['8080:80'] }],
    ['volumes_from another container', { volumes_from: ['container:deployhub-victim'] }],
    ['compose label spoofing', { labels: { 'com.docker.compose.project': 'victim' } }],
    ['docker api socket', { use_api_socket: true }],
    ['build context outside', { build: { context: '/opt/deployhub/projects/victim' } }],
    ['build ssh forwarding', { build: { context: DIR, ssh: ['default'] } }],
    ['build host network', { build: { context: DIR, network: 'host' } }],
    ['dockerfile outside', { build: { context: DIR, dockerfile: '/etc/shadow' } }],
    ['env_file outside', { env_file: [{ path: '/opt/apsamo/.env', required: true }] }],
    ['external_links', { external_links: ['deployhub-victim'] }],
  ]
  for (const [label, extra] of rejected) {
    it(`rejects ${label}`, () => {
      expect(checkComposeModel(svc(extra), OPTS).errors.length).toBeGreaterThan(0)
    })
  }

  it('allows only the panel-assigned container_name when told to', () => {
    const ok = checkComposeModel(svc({ container_name: 'deployhub-shop' }), {
      ...OPTS,
      allowedContainerName: 'deployhub-shop',
    })
    expect(ok.errors).toEqual([])
    const bad = checkComposeModel(svc({ container_name: 'deployhub-other' }), {
      ...OPTS,
      allowedContainerName: 'deployhub-shop',
    })
    expect(bad.errors.length).toBe(1)
  })

  it('rejects a project name that differs from the directory', () => {
    const res = checkComposeModel({ ...svc({}), name: 'victim' }, OPTS)
    expect(res.errors.join(' ')).toContain('project name')
  })

  it('rejects external volumes, host-path volume drivers and foreign external networks', () => {
    const res = checkComposeModel(
      {
        name: 'shop',
        services: { app: { image: 'x' } },
        volumes: {
          stolen: { name: 'victim_dbdata', external: true },
          hostdir: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: '/etc' } },
        },
        networks: { theirs: { name: 'victim_default', external: true } },
      },
      OPTS
    )
    expect(res.errors.length).toBe(3)
  })

  it('rejects secrets read from outside the project', () => {
    const res = checkComposeModel(
      { name: 'shop', services: { app: { image: 'x' } }, secrets: { s: { file: '/root/.ssh/id_rsa' } } },
      OPTS
    )
    expect(res.errors.length).toBe(1)
  })

  it('rejects a non-object model', () => {
    expect(checkComposeModel(null, OPTS).errors.length).toBe(1)
  })
})

describe('scanComposeText (C2, cross-file features)', () => {
  it('accepts a plain compose file with a relative env_file', () => {
    const res = scanComposeText('services:\n  app:\n    image: x\n    env_file: .env.production\n')
    expect(res.errors).toEqual([])
    expect(res.envFiles).toEqual(['.env.production'])
  })

  it('rejects include', () => {
    expect(scanComposeText('include:\n  - ../victim/compose.yaml\nservices: {}\n').errors.length).toBe(1)
  })

  it('rejects extends from another file', () => {
    const t = 'services:\n  app:\n    extends:\n      file: /opt/deployhub/projects/victim/docker-compose.yml\n      service: app\n'
    expect(scanComposeText(t).errors.length).toBeGreaterThan(0)
  })

  it('rejects env_file outside the project (list and long forms)', () => {
    expect(scanComposeText('services:\n  app:\n    env_file:\n      - /opt/apsamo/.env\n').errors.length).toBe(1)
    expect(scanComposeText('services:\n  app:\n    env_file:\n      - path: ../other/.env\n        required: true\n').errors.length).toBe(1)
    expect(scanComposeText('services:\n  app:\n    env_file: [ "${HOME}/.env" ]\n').errors.length).toBe(1)
  })

  it('ignores commented-out keys', () => {
    expect(scanComposeText('# include:\nservices:\n  app:\n    image: x\n').errors).toEqual([])
  })

  it('flags .env variables that redirect compose', () => {
    expect(DANGEROUS_COMPOSE_ENV_RE.test('APP=1\nCOMPOSE_PROJECT_NAME=victim\n')).toBe(true)
    expect(DANGEROUS_COMPOSE_ENV_RE.test('export COMPOSE_FILE=/x.yml')).toBe(true)
    expect(DANGEROUS_COMPOSE_ENV_RE.test('APP_KEY=base64:abc\nCOMPOSE_PROFILES=web\n')).toBe(false)
  })
})

// ─── Git URLs ───────────────────────────────────────────────────────────

describe('validateGitUrl (create-time)', () => {
  const ok = [
    'https://github.com/acme/site.git',
    'https://gitlab.com/acme/group/site',
    'git@github.com:acme/site.git',
    '  https://bitbucket.org/acme/site  ',
  ]
  for (const u of ok) {
    it(`accepts ${u.trim()}`, () => expect(validateGitUrl(u).ok).toBe(true))
  }

  const bad = [
    '/opt/deployhub/projects/victim',
    '../victim',
    'file:///opt/deployhub/projects/victim',
    'ext::sh -c touch% /tmp/pwned',
    'http://github.com/acme/site',
    'https://localhost/repo',
    'https://127.0.0.1/repo',
    'https://169.254.169.254/latest',
    'https://[::1]/repo',
    'git@-oProxyCommand=evil:repo',
    'git@github.com:-upload-pack=evil',
    '--upload-pack=touch /tmp/x',
    'https://github.com/acme/site\n--upload-pack=x',
    '',
  ]
  for (const u of bad) {
    it(`rejects ${JSON.stringify(u)}`, () => expect(validateGitUrl(u).ok).toBe(false))
  }

  it('rejects non-strings', () => {
    expect(validateGitUrl(undefined).ok).toBe(false)
    expect(validateGitUrl(42).ok).toBe(false)
  })
})

describe('isRemoteGitUrl (deployer defence in depth)', () => {
  it('accepts remote URLs, including legacy http://', () => {
    expect(isRemoteGitUrl('https://github.com/a/b')).toBe(true)
    expect(isRemoteGitUrl('http://git.example.com/a/b')).toBe(true)
    expect(isRemoteGitUrl('git@github.com:a/b.git')).toBe(true)
  })
  it('rejects local paths and helper transports', () => {
    expect(isRemoteGitUrl('/opt/deployhub/projects/victim')).toBe(false)
    expect(isRemoteGitUrl('file:///etc')).toBe(false)
    expect(isRemoteGitUrl('ext::sh -c id')).toBe(false)
    expect(isRemoteGitUrl('-u')).toBe(false)
    expect(isRemoteGitUrl(null)).toBe(false)
  })
  it('rejects option-looking branches', () => {
    expect(isSafeGitBranch('main')).toBe(true)
    expect(isSafeGitBranch('feature/x-1')).toBe(true)
    expect(isSafeGitBranch('--orphan')).toBe(false)
    expect(isSafeGitBranch('a b')).toBe(false)
  })
})

// ─── HTTP readiness ─────────────────────────────────────────────────────

describe('HTTP readiness (H2)', () => {
  it('accepts any real status below 500', () => {
    for (const c of [200, 204, 301, 302, 401, 403, 404, '200']) {
      expect(isAcceptableHttpStatus(c)).toBe(true)
    }
  })
  it('rejects 5xx and "no connection"', () => {
    for (const c of [500, 502, 503, '000', '', 'abc', 0]) {
      expect(isAcceptableHttpStatus(c)).toBe(false)
    }
  })
  it('builds a probe script for the assigned port with quoted container name', () => {
    const s = httpProbeScript({ hostPort: 30001, containerName: "x'; rm -rf /", containerPort: 80 })
    expect(s).toContain('127.0.0.1:30001')
    expect(s).toContain("'x'\\''; rm -rf /'")
    expect(s).toContain('PROBE_OK')
    expect(s).toContain('PROBE_FAIL')
  })
})
