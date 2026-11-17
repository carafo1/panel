/** Help center: public reading/search, suggestions, feedback and staff editing. */
import { describe, it, expect } from 'bun:test'
import { db } from '@/lib/db'
import * as help from '@/app/api/help/route'
import * as feedback from '@/app/api/help/[slug]/feedback/route'
import * as adminHelp from '@/app/api/admin/help/route'
import * as adminArticle from '@/app/api/admin/help/[id]/route'
import { getPublished } from '@/lib/help'
import { makeUser, authed, params } from './helpers'

let ip = 0
const anon = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.88.${++ip & 255}.${(ip >> 8) & 255}` } })
const list = async (qs = '') => (await help.GET(anon(`/api/help${qs}`))).json()

describe('help center', () => {
  it('creates the starter articles once, publicly readable', async () => {
    const first = await list()
    expect(first.articles.length).toBeGreaterThan(5)
    expect(first.articles[0]).not.toHaveProperty('body')
    // Deleting everything does not bring them back.
    await db.helpArticle.deleteMany({})
    expect((await list()).articles).toHaveLength(0)
  })

  it('staff create, edit and publish articles; customers cannot', async () => {
    const admin = await makeUser('h-admin', 'admin')
    const cust = await makeUser('h-cust')
    const create = (token: string, body: Record<string, unknown>) =>
      adminHelp.POST(authed(token, '/api/admin/help', { method: 'POST', body: JSON.stringify(body) }))

    expect((await create(cust.token, { title: 'Nope', body: 'x' })).status).toBe(403)
    expect((await create(admin.token, { title: 'Bad slug', slug: 'Has Spaces', body: 'x' })).status).toBe(400)

    const res = await create(admin.token, { title: 'Reset your WordPress password', body: 'Use **Site tools**.', category: 'hosting', published: false })
    expect(res.status).toBe(201)
    const { article } = await res.json()
    expect(article.slug).toBe('reset-your-wordpress-password')
    expect((await create(admin.token, { title: 'Reset your WordPress password', body: 'dup' })).status).toBe(409)

    // Drafts are invisible to the public.
    expect((await list()).articles.some((a: { slug: string }) => a.slug === article.slug)).toBe(false)
    expect(await getPublished(article.slug)).toBeNull()

    const patch = await adminArticle.PATCH(
      authed(admin.token, `/api/admin/help/${article.id}`, { method: 'PATCH', body: JSON.stringify({ published: true, summary: 'Locked out of wp-admin?' }) }),
      params({ id: article.id })
    )
    expect(patch.status).toBe(200)
    expect((await list()).articles.some((a: { slug: string }) => a.slug === article.slug)).toBe(true)

    // Search is case-insensitive and suggestions match separate words.
    expect((await list('?q=WORDPRESS')).articles[0].slug).toBe(article.slug)
    const sug = await list(`?suggest=${encodeURIComponent('my wordpress admin password is lost')}`)
    expect(sug.articles[0].slug).toBe(article.slug)

    const viewed = await getPublished(article.slug)
    expect(viewed?.body).toContain('Site tools')

    const del = await adminArticle.DELETE(authed(admin.token, `/api/admin/help/${article.id}`, { method: 'DELETE' }), params({ id: article.id }))
    expect(del.status).toBe(200)
  })

  it('records helpful / not helpful votes', async () => {
    const a = await db.helpArticle.create({ data: { slug: 'vote-me', title: 'Vote me', body: 'x' } })
    const vote = (helpful: unknown) => feedback.POST(anon('/api/help/vote-me/feedback', { method: 'POST', body: JSON.stringify({ helpful }) }), params({ slug: 'vote-me' }))
    expect((await vote(true)).status).toBe(200)
    expect((await vote(false)).status).toBe(200)
    expect((await vote('yes')).status).toBe(400)
    const after = await db.helpArticle.findUnique({ where: { id: a.id } })
    expect([after?.helpfulYes, after?.helpfulNo]).toEqual([1, 1])
    const missing = await feedback.POST(anon('/api/help/nope/feedback', { method: 'POST', body: JSON.stringify({ helpful: true }) }), params({ slug: 'nope' }))
    expect(missing.status).toBe(404)
  })
})
