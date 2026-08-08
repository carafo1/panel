/**
 * GET /api/admin/search?q=…
 *
 * One box that finds anything by any identifier a customer might quote.
 *
 * Support calls do not arrive with a user id. They arrive as "my site is
 * down" from an address, or a domain, or an invoice number — and until now an
 * operator had to guess which admin tab that identifier lived in and page
 * through it. This searches every entity an operator is likely to be handed
 * and returns enough context to act without a second lookup.
 *
 * Read-only, admin-only, and capped: a broad term like "a" must not drag the
 * whole database into a response.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdminRole } from '@/lib/auth'

/** Per-entity cap. Keeps a one-letter query cheap and the response readable. */
const LIMIT = 8

export interface SearchHit {
  type: 'user' | 'project' | 'domain' | 'email' | 'subscription' | 'invoice' | 'payment'
  id: string
  title: string
  subtitle: string
  /** Which customer this belongs to, so an operator can pivot to them. */
  ownerEmail?: string | null
  status?: string | null
}

export async function GET(request: Request) {
  try {
    const auth = await requireAdminRole(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const q = (new URL(request.url).searchParams.get('q') || '').trim()
    if (q.length < 2) {
      return NextResponse.json({
        query: q,
        results: [],
        message: 'Type at least two characters.',
      })
    }

    // SQLite's `contains` is already case-insensitive for ASCII under the
    // default NOCASE-ish collation used here; lowering the term keeps
    // behaviour the same if the datasource ever changes.
    const term = q.toLowerCase()
    const like = { contains: term }

    const [users, projects, domains, emails, invoices, payments, subs] =
      await Promise.all([
        db.user
          .findMany({
            where: { OR: [{ email: like }, { name: like }] },
            select: { id: true, email: true, name: true, role: true, status: true },
            take: LIMIT,
          })
          .catch(() => []),
        db.project
          .findMany({
            where: {
              OR: [
                { name: like },
                { slug: like },
                { subdomain: like },
                { customDomain: like },
              ],
            },
            select: {
              id: true,
              name: true,
              slug: true,
              status: true,
              subdomain: true,
              customDomain: true,
              user: { select: { email: true } },
            },
            take: LIMIT,
          })
          .catch(() => []),
        db.domain
          .findMany({
            where: { name: like },
            select: {
              id: true,
              name: true,
              status: true,
              registrar: true,
              user: { select: { email: true } },
            },
            take: LIMIT,
          })
          .catch(() => []),
        db.emailService
          .findMany({
            where: { domain: like },
            select: {
              id: true,
              domain: true,
              status: true,
              user: { select: { email: true } },
              plan: { select: { name: true } },
            },
            take: LIMIT,
          })
          .catch(() => []),
        db.invoice
          .findMany({
            where: { number: like },
            select: {
              id: true,
              number: true,
              status: true,
              total: true,
              user: { select: { email: true } },
            },
            take: LIMIT,
          })
          .catch(() => []),
        // Customers quote the payment reference from their bank transfer, so
        // that is the field worth matching rather than the internal id.
        db.payment
          .findMany({
            where: { transactionId: like },
            select: {
              id: true,
              transactionId: true,
              status: true,
              amount: true,
              method: true,
              user: { select: { email: true } },
            },
            take: LIMIT,
          })
          .catch(() => []),
        // Subscriptions have no human-readable identifier, so this only makes
        // sense as an exact id lookup — someone pasting one out of a log.
        q.length > 20
          ? db.subscription
              .findMany({
                where: { id: q },
                select: {
                  id: true,
                  status: true,
                  currentPeriodEnd: true,
                  user: { select: { email: true } },
                  plan: { select: { name: true } },
                },
                take: 1,
              })
              .catch(() => [])
          : Promise.resolve([]),
      ])

    const results: SearchHit[] = [
      ...users.map((u) => ({
        type: 'user' as const,
        id: u.id,
        title: u.email,
        subtitle: `${u.name || 'No name'} · ${u.role}`,
        ownerEmail: u.email,
        status: u.status,
      })),
      ...projects.map((p) => ({
        type: 'project' as const,
        id: p.id,
        title: p.name,
        subtitle: p.customDomain || p.subdomain || p.slug,
        ownerEmail: p.user?.email ?? null,
        status: p.status,
      })),
      ...domains.map((d) => ({
        type: 'domain' as const,
        id: d.id,
        title: d.name,
        subtitle: `Registrar: ${d.registrar}`,
        ownerEmail: d.user?.email ?? null,
        status: d.status,
      })),
      ...emails.map((e) => ({
        type: 'email' as const,
        id: e.id,
        title: e.domain,
        subtitle: `Email hosting · ${e.plan?.name || 'no plan'}`,
        ownerEmail: e.user?.email ?? null,
        status: e.status,
      })),
      ...invoices.map((i) => ({
        type: 'invoice' as const,
        id: i.id,
        title: i.number || i.id,
        subtitle: `Invoice · ${i.total}`,
        ownerEmail: i.user?.email ?? null,
        status: i.status,
      })),
      ...payments.map((p) => ({
        type: 'payment' as const,
        id: p.id,
        title: p.transactionId || p.id,
        subtitle: `${p.method} · ${p.amount}`,
        ownerEmail: p.user?.email ?? null,
        status: p.status,
      })),
      ...subs.map((s) => ({
        type: 'subscription' as const,
        id: s.id,
        title: s.plan?.name || 'Subscription',
        subtitle: `Ends ${new Date(s.currentPeriodEnd).toDateString()}`,
        ownerEmail: s.user?.email ?? null,
        status: s.status,
      })),
    ]

    return NextResponse.json({
      query: q,
      total: results.length,
      // Grouped as well as flat: the UI renders sections, but a keyboard
      // palette wants one ordered list.
      results,
      byType: results.reduce<Record<string, number>>((acc, r) => {
        acc[r.type] = (acc[r.type] || 0) + 1
        return acc
      }, {}),
      truncated: [users, projects, domains, emails, invoices, payments].some(
        (g) => g.length === LIMIT
      ),
    })
  } catch (error) {
    console.error('Admin search error:', error)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}
