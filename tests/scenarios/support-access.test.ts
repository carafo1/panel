/**
 * Support access ("Log in as customer"): a super admin's browser switches to a
 * 1-hour session as the customer, the page shows who is really behind it, and
 * "Return to admin" restores the admin's own login without a password.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { sessionCookieName, supportReturnCookieName } from '@/lib/session'
import { issueSession } from '@/lib/auth'
import * as impersonate from '@/app/api/admin/impersonate/route'
import * as end from '@/app/api/auth/support/end/route'
import * as me from '@/app/api/auth/me/route'
import { makeUser } from './helpers'

const HOST = 'panel.test'
type U = Awaited<ReturnType<typeof makeUser>>
let superAdmin: U
let admin: U
let customer: U
let superToken: string

function req(path: string, opts: { method?: string; auth?: string; cookie?: string; site?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { host: HOST, 'sec-fetch-site': opts.site || 'same-origin' }
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  return new NextRequest(`https://${HOST}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

/** name=value pairs from a response's Set-Cookie headers. */
function setCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';')
    const eq = pair.indexOf('=')
    out[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return out
}

beforeAll(async () => {
  superAdmin = await makeUser('sup-super', 'super_admin')
  admin = await makeUser('sup-admin', 'admin')
  customer = await makeUser('sup-customer')
  // A real tracked session, as a browser login would have.
  superToken = await issueSession({ userId: superAdmin.id, email: superAdmin.email, role: 'super_admin' })
})

describe('support access', () => {
  it('switches the browser into the customer, shows the banner, and returns to the admin', async () => {
    const start = await impersonate.POST(
      req('/api/admin/impersonate', { method: 'POST', auth: superToken, body: { userId: customer.id, switchSession: true } })
    )
    expect(start.status).toBe(200)
    const startBody = await start.json()
    expect(startBody.token).toBeUndefined() // never handed to page scripts
    const cookies = setCookies(start)
    const supportToken = cookies[sessionCookieName()]
    expect(supportToken).toBeTruthy()
    expect(cookies[supportReturnCookieName()]).toBe(superToken)

    // The panel now sees the customer, and knows who is really looking.
    const who = await (await me.GET(req('/api/auth/me', { auth: supportToken }))).json()
    expect(who.user.id).toBe(customer.id)
    expect(who.user.supportSession.adminEmail).toBe(superAdmin.email)

    // Return to admin: the support session ends, the admin session is back.
    const back = await end.POST(
      req('/api/auth/support/end', { method: 'POST', auth: supportToken, cookie: `${supportReturnCookieName()}=${superToken}` })
    )
    expect(back.status).toBe(200)
    expect((await back.json()).returnedToAdmin).toBe(true)
    const after = setCookies(back)
    expect(after[sessionCookieName()]).toBe(superToken)
    expect(after[supportReturnCookieName()]).toBe('')
    expect((await me.GET(req('/api/auth/me', { auth: supportToken }))).status).toBe(401) // support session is dead
  })

  it('cannot restore someone else’s session through a planted return cookie', async () => {
    const start = await impersonate.POST(
      req('/api/admin/impersonate', { method: 'POST', auth: superToken, body: { userId: customer.id, switchSession: true } })
    )
    const supportToken = setCookies(start)[sessionCookieName()]
    const adminToken = await issueSession({ userId: admin.id, email: admin.email, role: 'admin' })
    const back = await end.POST(
      req('/api/auth/support/end', { method: 'POST', auth: supportToken, cookie: `${supportReturnCookieName()}=${adminToken}` })
    )
    expect((await back.json()).returnedToAdmin).toBe(false)
    expect(setCookies(back)[sessionCookieName()]).toBe('') // just signed out
  })

  it('only super admins can start it, never from another site, never on admins', async () => {
    const adminToken = await issueSession({ userId: admin.id, email: admin.email, role: 'admin' })
    expect((await impersonate.POST(req('/api/admin/impersonate', { method: 'POST', auth: adminToken, body: { userId: customer.id, switchSession: true } }))).status).toBe(403)
    expect(
      (await impersonate.POST(req('/api/admin/impersonate', { method: 'POST', auth: superToken, site: 'cross-site', body: { userId: customer.id, switchSession: true } }))).status
    ).toBe(403)
    expect((await impersonate.POST(req('/api/admin/impersonate', { method: 'POST', auth: superToken, body: { userId: admin.id, switchSession: true } }))).status).toBe(403)
  })

  it('"Return to admin" is refused when no support session is active, or from another site', async () => {
    expect((await end.POST(req('/api/auth/support/end', { method: 'POST', auth: superToken }))).status).toBe(400)
    expect((await end.POST(req('/api/auth/support/end', { method: 'POST', auth: superToken, site: 'cross-site' }))).status).toBe(403)
  })
})
