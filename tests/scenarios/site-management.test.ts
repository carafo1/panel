/**
 * Website management: WordPress tools, App tools for other stacks, and the
 * Files path errors. Projects here have no server, so they run in demo mode
 * (development only) — what is under test is the API contract, permissions
 * and input validation that guard the real WP-CLI / docker exec commands.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import * as wp from '@/app/api/hosting/[id]/wordpress/route'
import * as tools from '@/app/api/hosting/[id]/app-tools/route'
import * as files from '@/app/api/hosting/[id]/files/route'
import * as teamProjects from '@/app/api/teams/[teamId]/projects/route'
import { makeUser, makeProject, authed, params, uid } from './helpers'

type U = Awaited<ReturnType<typeof makeUser>>
let owner: U
let dev: U
let viewer: U
let outsider: U
let wpSite: string
let laravelSite: string
let staticSite: string

const wpGet = (u: U, id = wpSite) => wp.GET(authed(u.token, `/api/hosting/${id}/wordpress`), params({ id }))
const wpPost = (u: U, body: unknown, id = wpSite) =>
  wp.POST(authed(u.token, `/api/hosting/${id}/wordpress`, { method: 'POST', body: JSON.stringify(body) }), params({ id }))
const toolsGet = (u: U, id: string) => tools.GET(authed(u.token, `/api/hosting/${id}/app-tools`), params({ id }))
const toolsPost = (u: U, id: string, tool: string) =>
  tools.POST(authed(u.token, `/api/hosting/${id}/app-tools`, { method: 'POST', body: JSON.stringify({ tool }) }), params({ id }))

beforeAll(async () => {
  owner = await makeUser('wp-owner')
  dev = await makeUser('wp-dev')
  viewer = await makeUser('wp-viewer')
  outsider = await makeUser('wp-outsider')
  wpSite = (await makeProject(owner.id, { deploymentMethod: 'wordpress', stack: 'wordpress', framework: 'wordpress', wpAdminUser: 'siteadmin' })).id
  laravelSite = (await makeProject(owner.id, { deploymentMethod: 'laravel', stack: 'php', framework: 'laravel' })).id
  staticSite = (await makeProject(owner.id, { deploymentMethod: 'static', stack: 'static', framework: 'static' })).id

  const team = await db.team.create({ data: { name: 'Site crew', slug: uid('crew'), ownerId: owner.id } })
  await db.teamMember.createMany({
    data: [
      { teamId: team.id, userId: owner.id, role: 'owner' },
      { teamId: team.id, userId: dev.id, role: 'developer' },
      { teamId: team.id, userId: viewer.id, role: 'viewer' },
    ],
  })
  for (const pid of [wpSite, laravelSite]) {
    const r = await teamProjects.POST(
      authed(owner.token, `/api/teams/${team.id}/projects`, { method: 'POST', body: JSON.stringify({ projectId: pid }) }),
      params({ teamId: team.id })
    )
    expect(r.status).toBeLessThan(300)
  }
})

describe('WordPress tools', () => {
  it('shows core, plugins and themes', async () => {
    const res = await wpGet(owner)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.coreVersion).toBeTruthy()
    expect(Array.isArray(body.plugins)).toBe(true)
    expect(Array.isArray(body.themes)).toBe(true)
    expect(body.adminUrl).toContain('/wp-admin/')
  })

  it('installs, activates, deactivates and deletes a plugin', async () => {
    expect((await wpPost(owner, { action: 'plugin_install', slug: 'woocommerce', activate: true })).status).toBe(200)
    let plugins = (await (await wpGet(owner)).json()).plugins as Array<{ name: string; status: string }>
    expect(plugins.find((p) => p.name === 'woocommerce')?.status).toBe('active')

    expect((await wpPost(owner, { action: 'plugin_deactivate', slug: 'woocommerce' })).status).toBe(200)
    expect((await wpPost(owner, { action: 'plugin_delete', slug: 'woocommerce' })).status).toBe(200)
    plugins = (await (await wpGet(owner)).json()).plugins
    expect(plugins.some((p) => p.name === 'woocommerce')).toBe(false)
  })

  it('refuses to delete the active theme', async () => {
    const themes = (await (await wpGet(owner)).json()).themes as Array<{ name: string; status: string }>
    const active = themes.find((t) => t.status === 'active')!
    const res = await wpPost(owner, { action: 'theme_delete', slug: active.name })
    expect(res.status).toBe(422)
  })

  it('rejects slugs that could smuggle shell syntax', async () => {
    for (const slug of ['x; rm -rf /', '$(id)', '../../etc', 'A Plugin', '`whoami`', '-rf']) {
      const res = await wpPost(owner, { action: 'plugin_install', slug })
      expect(res.status).toBe(400)
    }
  })

  it('rejects multi-line search-replace input and identical values', async () => {
    expect((await wpPost(owner, { action: 'search_replace', from: 'a\nb', to: 'c', dryRun: true })).status).toBe(400)
    expect((await wpPost(owner, { action: 'search_replace', from: 'same', to: 'same', dryRun: true })).status).toBe(400)
    const ok = await wpPost(owner, { action: 'search_replace', from: 'http://old.test', to: 'https://new.test', dryRun: true })
    expect(ok.status).toBe(200)
    expect(typeof (await ok.json()).replacements).toBe('number')
  })

  it('maintenance and debug switches stick', async () => {
    await wpPost(owner, { action: 'maintenance_on' })
    await wpPost(owner, { action: 'debug_on' })
    const body = await (await wpGet(owner)).json()
    expect(body.maintenance).toBe(true)
    expect(body.debug).toBe(true)
    await wpPost(owner, { action: 'maintenance_off' })
    await wpPost(owner, { action: 'debug_off' })
  })

  it('resetting the admin password returns it once and stores it encrypted', async () => {
    const res = await wpPost(owner, { action: 'reset_admin_password', user: 'siteadmin' })
    expect(res.status).toBe(200)
    const { password } = await res.json()
    expect(typeof password).toBe('string')
    expect(password.length).toBeGreaterThanOrEqual(20)
    const row = await db.project.findUnique({ where: { id: wpSite }, select: { wpAdminPassword: true } })
    expect(row!.wpAdminPassword).toBeTruthy()
    expect(row!.wpAdminPassword).not.toContain(password)
  })

  it('enforces team permissions per action', async () => {
    expect((await wpGet(viewer)).status).toBe(200) // viewers can look
    expect((await wpPost(viewer, { action: 'cache_flush' })).status).toBe(403)
    expect((await wpPost(dev, { action: 'cache_flush' })).status).toBe(200) // developers configure
    expect((await wpPost(dev, { action: 'reset_admin_password' })).status).toBe(403) // owner only
    expect((await wpPost(dev, { action: 'search_replace', from: 'a', to: 'b', dryRun: true })).status).toBe(403) // data
  })

  it("is invisible to other customers and refuses non-WordPress sites", async () => {
    expect([403, 404]).toContain((await wpGet(outsider)).status)
    expect((await wpGet(owner, laravelSite)).status).toBe(409)
    expect((await wpPost(owner, { action: 'not_a_thing' })).status).toBe(400)
  })
})

describe('App tools', () => {
  it('lists the Laravel commands', async () => {
    const res = await toolsGet(owner, laravelSite)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stack).toBe('laravel')
    expect(body.tools.map((t: { id: string }) => t.id)).toContain('migrate')
    expect(body.hasLog).toBe(true)
  })

  it('runs only catalogue tools — no free-form commands', async () => {
    expect((await toolsPost(owner, laravelSite, 'optimize_clear')).status).toBe(200)
    expect((await toolsPost(owner, laravelSite, 'rm -rf /')).status).toBe(400)
    expect((await toolsPost(owner, laravelSite, '')).status).toBe(400)
  })

  it('migrations need data permission; viewers can read the log', async () => {
    expect((await toolsPost(dev, laravelSite, 'migrate')).status).toBe(403)
    expect((await toolsPost(owner, laravelSite, 'migrate')).status).toBe(200)
    expect((await toolsPost(viewer, laravelSite, '__log')).status).toBe(200)
    expect((await toolsPost(viewer, laravelSite, 'optimize_clear')).status).toBe(403)
  })

  it('static sites have no app tools', async () => {
    expect((await toolsGet(owner, staticSite)).status).toBe(409)
  })
})

describe('Files: refused paths are the caller’s mistake, not a server error', () => {
  it('absolute and parent paths get 400 with the reason', async () => {
    const res = await files.POST(
      authed(owner.token, `/api/hosting/${staticSite}/files`, { method: 'POST', body: JSON.stringify({ action: 'mkdir', path: '/etc/evil' }) }),
      params({ id: staticSite })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/absolute paths are not allowed/i)
  })

  it('a site that was never deployed says so instead of "internal error"', async () => {
    const res = await files.GET(authed(owner.token, `/api/hosting/${staticSite}/files?path=.`), params({ id: staticSite }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not been deployed/i)
  })
})
