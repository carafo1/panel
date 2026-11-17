/**
 * Help center articles. Staff edit them in Admin → Help; customers read them
 * at /help without signing in. Bodies are Markdown, rendered without raw HTML
 * (react-markdown's default), so an article cannot carry script.
 *
 * A starter set is created once, the first time the help center is read with
 * no articles — deleting them later does not bring them back.
 */
import { db } from '@/lib/db'
import { NS1_HOSTNAME, NS2_HOSTNAME, SUPPORT_EMAIL } from '@/lib/brand-config'

export const HELP_CATEGORIES = [
  { key: 'getting-started', label: 'Getting started' },
  { key: 'hosting', label: 'Websites & hosting' },
  { key: 'domains', label: 'Domains & DNS' },
  { key: 'email', label: 'Email' },
  { key: 'billing', label: 'Billing' },
  { key: 'account', label: 'Account & security' },
] as const
const CATEGORY_KEYS = HELP_CATEGORIES.map((c) => c.key) as string[]

export class HelpError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

const SEEDED_KEY = 'help.seeded'

function starterArticles() {
  return [
    {
      slug: 'put-your-first-website-online',
      category: 'getting-started',
      title: 'Put your first website online',
      summary: 'Create a site from a template, a Git repository or an upload.',
      body: `Open **Hosting** in your panel and choose **New project**.\n\nYou can start from:\n\n- **A template** — WordPress and other ready-made stacks.\n- **A GitHub repository** — connect GitHub once, then pick the repository and branch. New pushes can deploy automatically.\n- **An upload** — a ZIP of your site's files.\n\nEvery site gets a free address on our domain straight away. When it shows **Running**, open it from the project page. To use your own domain, see *Connect your domain*.`,
    },
    {
      slug: 'connect-your-domain',
      category: 'domains',
      title: 'Connect your domain to a website',
      summary: 'Point a domain you own at a site hosted with us.',
      body: `1. Open the website in **Hosting** and go to **Domains**.\n2. Add your domain, for example \`example.com\`.\n3. At the company where the domain is registered, either:\n   - change the nameservers to \`${NS1_HOSTNAME}\` and \`${NS2_HOSTNAME}\` (we then manage DNS for you), **or**\n   - keep your nameservers and create the DNS records the panel shows you.\n\nDNS changes can take from a few minutes up to 48 hours to be seen everywhere. The panel re-checks automatically and issues a free SSL certificate once the domain points to us.`,
    },
    {
      slug: 'ssl-certificates',
      category: 'hosting',
      title: 'HTTPS and SSL certificates',
      summary: 'Certificates are issued and renewed for you.',
      body: `Every website and connected domain gets a free SSL certificate once its DNS points to us. Certificates renew automatically; you do not need to do anything.\n\nIf your site still shows a certificate warning:\n\n- check the domain's DNS points to us (see *Connect your domain*);\n- wait a few minutes after a DNS change — the certificate is requested on the first visit after the domain resolves to us.\n\nStill stuck after an hour? Open a support ticket and include the domain.`,
    },
    {
      slug: 'backups-and-restore',
      category: 'hosting',
      title: 'Backups and restoring a site',
      summary: 'Take a backup before big changes and restore it if something breaks.',
      body: `Open the website in **Hosting** and go to **Backups**.\n\n- **Back up now** saves the site's files and database.\n- **Restore** replaces the current site with the chosen backup. Anything changed since that backup is lost, so take a fresh backup first if you're unsure.\n\nYou can also download a backup to keep your own copy.`,
    },
    {
      slug: 'set-up-email',
      category: 'email',
      title: 'Set up email for your domain',
      summary: 'Create mailboxes like you@example.com and connect your mail app.',
      body: `1. Open **Email Hosting** and add your domain.\n2. If we manage your DNS, the mail records are added for you. Otherwise, add the MX, SPF, DKIM and DMARC records the panel lists at your DNS provider.\n3. Create mailboxes.\n\nThe panel shows the incoming (IMAP) and outgoing (SMTP) server settings for your mail app, and a webmail link. Mail may take until DNS has updated to start arriving.`,
    },
    {
      slug: 'invoices-and-payments',
      category: 'billing',
      title: 'Invoices, payments and renewals',
      summary: 'Where to find invoices and how renewals work.',
      body: `Open **Billing** to see your plan, invoices and payment methods.\n\n- Plans and domains renew automatically at the end of each period.\n- We email you before a renewal and when an invoice is issued.\n- If a payment fails, the service stays up for a grace period while you update your payment method. After that it may be suspended until the invoice is paid.\n\nQuestions about a charge? Open a support ticket with the **Billing** topic.`,
    },
    {
      slug: 'two-factor-authentication',
      category: 'account',
      title: 'Turn on two-factor authentication',
      summary: 'Protect your account with an authenticator app.',
      body: `Go to **Settings → Security** and choose **Enable 2FA**. Scan the QR code with an authenticator app (such as Google Authenticator, 1Password or Authy) and enter the 6-digit code to confirm.\n\nFrom then on you'll be asked for a code when you sign in. Under **Active sessions** on the same page you can see where you're signed in and sign out other devices.`,
    },
    {
      slug: 'export-or-delete-your-data',
      category: 'account',
      title: 'Download or delete your data',
      summary: 'Get a copy of your account data, or close your account.',
      body: `In **Settings → Security**, under **Your data**:\n\n- **Download my data** gives you a JSON file with your account, websites, domains, invoices and settings (no passwords or secret keys).\n- **Delete account** removes your websites, mailboxes and settings and signs you out everywhere. It cannot be undone. Unpaid invoices and active registered domains must be settled or transferred out first — the dialog tells you what's in the way.\n\nInvoices are kept for our accounting records, as the law requires.`,
    },
    {
      slug: 'contact-support',
      category: 'getting-started',
      title: 'How to contact support',
      summary: 'Open a ticket and chat with our team.',
      body: `Open **Support** in your panel and choose **New ticket**. Pick a topic and, if it's about a website, select it — that saves a round of questions.\n\nReplies appear in the ticket straight away and are emailed to you. You can also write to ${SUPPORT_EMAIL}.\n\nIf many customers are affected by the same issue, we post it on the [status page](/status).`,
    },
  ]
}

async function ensureStarterArticles() {
  const seeded = await db.appSetting.findUnique({ where: { key: SEEDED_KEY } })
  if (seeded) return
  // Mark first so concurrent requests don't both insert.
  try {
    await db.appSetting.create({ data: { key: SEEDED_KEY, value: new Date().toISOString() } })
  } catch {
    return
  }
  if ((await db.helpArticle.count()) > 0) return
  const items = starterArticles()
  for (const [i, a] of items.entries()) {
    await db.helpArticle.create({ data: { ...a, order: i } }).catch(() => {})
  }
}

type ListItem = { id: string; slug: string; title: string; summary: string; category: string; updatedAt: Date }
const toItem = (r: ListItem): ListItem => ({ id: r.id, slug: r.slug, title: r.title, summary: r.summary, category: r.category, updatedAt: r.updatedAt })

/**
 * Searched in memory: a help center has tens of articles, and this keeps
 * matching case-insensitive on both SQLite and PostgreSQL.
 */
async function allPublished() {
  await ensureStarterArticles()
  return db.helpArticle.findMany({
    where: { published: true },
    orderBy: [{ category: 'asc' }, { order: 'asc' }, { title: 'asc' }],
    take: 500,
  })
}

export async function listPublished(q?: string) {
  const rows = await allPublished()
  const term = q?.trim().toLowerCase().slice(0, 100)
  if (!term) return rows.map(toItem)
  return rows
    .map((r) => {
      const head = `${r.title} ${r.summary}`.toLowerCase()
      return { r, score: head.includes(term) ? 2 : r.body.toLowerCase().includes(term) ? 1 : 0 }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((x) => toItem(x.r))
}

/** Matches words separately, so "domain not working" finds "Connect your domain". */
export async function suggestArticles(text: string) {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, 8)
  if (words.length === 0) return []
  const rows = await allPublished()
  return rows
    .map((r) => {
      const head = `${r.title} ${r.summary}`.toLowerCase()
      return { r, score: words.filter((w) => head.includes(w)).length }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => toItem(x.r))
}

export async function getPublished(slug: string) {
  await ensureStarterArticles()
  const a = await db.helpArticle.findUnique({ where: { slug } })
  if (!a || !a.published) return null
  await db.helpArticle.update({ where: { id: a.id }, data: { views: { increment: 1 } } }).catch(() => {})
  return a
}

export async function recordFeedback(slug: string, helpful: boolean) {
  const res = await db.helpArticle.updateMany({
    where: { slug, published: true },
    data: helpful ? { helpfulYes: { increment: 1 } } : { helpfulNo: { increment: 1 } },
  })
  if (!res.count) throw new HelpError('Article not found.', 404)
}

// ── Staff ─────────────────────────────────────────────────────────────

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function clean(input: Record<string, unknown>, partial: boolean) {
  const data: Record<string, unknown> = {}
  const text = (k: string, label: string, min: number, max: number) => {
    if (input[k] === undefined && partial) return
    const v = typeof input[k] === 'string' ? (input[k] as string).trim() : ''
    if (v.length < min) throw new HelpError(`${label} is required.`)
    if (v.length > max) throw new HelpError(`${label} must be at most ${max} characters.`)
    data[k] = v
  }
  text('title', 'Title', 3, 160)
  text('summary', 'Summary', 0, 300)
  text('body', 'Article text', 1, 50_000)
  if (input.slug !== undefined || !partial) {
    const slug = typeof input.slug === 'string' && input.slug.trim() ? input.slug.trim() : slugify(String(input.title ?? ''))
    if (!SLUG.test(slug) || slug.length > 80) throw new HelpError('The URL name may only use lowercase letters, numbers and dashes.')
    data.slug = slug
  }
  if (input.category !== undefined || !partial) {
    data.category = CATEGORY_KEYS.includes(input.category as string) ? input.category : 'getting-started'
  }
  if (input.published !== undefined) data.published = input.published === true
  if (input.order !== undefined) {
    const n = Number(input.order)
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new HelpError('Order must be a whole number.')
    data.order = n
  }
  return data
}

async function slugTaken(slug: string, exceptId?: string) {
  const other = await db.helpArticle.findUnique({ where: { slug }, select: { id: true } })
  return Boolean(other && other.id !== exceptId)
}

export async function listAllForStaff() {
  await ensureStarterArticles()
  return db.helpArticle.findMany({
    orderBy: [{ category: 'asc' }, { order: 'asc' }, { title: 'asc' }],
  })
}

export async function createArticle(userId: string, input: Record<string, unknown>) {
  const data = clean(input, false)
  if (await slugTaken(data.slug as string)) throw new HelpError('Another article already uses that URL name.', 409)
  return db.helpArticle.create({ data: { ...(data as { slug: string; title: string; body: string }), updatedById: userId } })
}

export async function updateArticle(id: string, userId: string, input: Record<string, unknown>) {
  const existing = await db.helpArticle.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new HelpError('Article not found.', 404)
  const data = clean(input, true)
  if (data.slug && (await slugTaken(data.slug as string, id))) throw new HelpError('Another article already uses that URL name.', 409)
  return db.helpArticle.update({ where: { id }, data: { ...data, updatedById: userId } })
}
