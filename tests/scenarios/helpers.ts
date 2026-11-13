/** Shared fixtures for scenario tests. Every name is unique per call. */
import { db } from '@/lib/db'
import { generateToken } from '@/lib/auth'

let seq = 0
export const uid = (tag: string) => `${tag}-${Date.now().toString(36)}-${(seq++).toString(36)}`

export const DAY = 24 * 60 * 60 * 1000

export async function makeUser(tag: string, role = 'user') {
  const u = await db.user.create({
    data: { email: `${uid(tag)}@example.test`, name: tag, password: 'x', role },
  })
  return { ...u, token: generateToken({ userId: u.id, email: u.email, role }) }
}

export async function makeProject(userId: string, extra: Record<string, unknown> = {}) {
  const slug = uid('site')
  return db.project.create({
    data: { userId, name: slug, slug, subdomain: `${slug}.apsamo.test`, status: 'running', ...extra },
  })
}

export async function makePlan(extra: Record<string, unknown> = {}) {
  const slug = uid('plan')
  return db.plan.create({
    data: {
      name: slug, slug, description: 'test', price: 10,
      ram: '1GB', cpu: '1', storage: '10GB', bandwidth: '100GB', billingCycle: 'monthly',
      ...extra,
    },
  })
}

/** A Request carrying a user's bearer token, as the browser sends it. */
export function authed(token: string | null, url: string, init: RequestInit = {}) {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })
