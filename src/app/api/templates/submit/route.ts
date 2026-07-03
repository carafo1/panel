/**
 * POST /api/templates/submit
 *
 * Submit a new community template to the marketplace.
 * Goes into "pending" status — admin must approve before it's visible.
 *
 * Body:
 *   {
 *     name: string,          // "My Awesome Starter"
 *     description: string,   // 1-2 sentences
 *     category: string,      // Framework | Backend | Static | CMS | Ecommerce | Blog | Portfolio | SaaS
 *     framework: string,     // nextjs | react | vue | nuxt | astro | svelte | express | fastapi | etc.
 *     icon: string,          // emoji
 *     repoUrl: string,       // GitHub repo URL (required)
 *     demoUrl?: string,      // live demo URL (optional)
 *     features: string[],    // ["TypeScript", "Tailwind", "Auth"]
 *     tags: string[],        // ["saas", "dashboard", "starter"]
 *     readme?: string,       // markdown README
 *     license?: string,      // MIT (default), Apache-2.0, GPL-3.0
 *   }
 *
 * Response: { template: { id, status: "pending", ... } }
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { sanitizeError } from '@/lib/security'

const VALID_CATEGORIES = ['Framework', 'Backend', 'Static', 'CMS', 'Ecommerce', 'Blog', 'Portfolio', 'SaaS', 'Fullstack', 'Frontend']
const VALID_FRAMEWORKS = ['nextjs', 'react', 'vue', 'nuxt', 'astro', 'svelte', 'express', 'fastapi', 'node', 'static', 'gatsby', 'go', 'php', 'python', 'ruby', 'laravel', 'django', 'flask', 'wordpress']
const VALID_LICENSES = ['MIT', 'Apache-2.0', 'GPL-3.0', 'BSD-3-Clause', 'MPL-2.0', 'Unlicense', 'Proprietary']
const GITHUB_URL_REGEX = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
    }
    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const body = await request.json()
    const { name, description, category, framework, icon, repoUrl, demoUrl, features, tags, readme, license } = body

    // ── Validation ──────────────────────────────────────────────────────
    if (!name || typeof name !== 'string' || name.trim().length < 3) {
      return NextResponse.json({ error: 'Name must be at least 3 characters' }, { status: 400 })
    }
    if (!description || typeof description !== 'string' || description.trim().length < 10) {
      return NextResponse.json({ error: 'Description must be at least 10 characters' }, { status: 400 })
    }
    if (!VALID_CATEGORIES.includes(category)) {
      return NextResponse.json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` }, { status: 400 })
    }
    if (!VALID_FRAMEWORKS.includes(framework)) {
      return NextResponse.json({ error: `Invalid framework. Must be one of: ${VALID_FRAMEWORKS.join(', ')}` }, { status: 400 })
    }
    if (!repoUrl || !GITHUB_URL_REGEX.test(repoUrl)) {
      return NextResponse.json({ error: 'repoUrl must be a valid GitHub URL (https://github.com/owner/repo)' }, { status: 400 })
    }
    if (demoUrl && typeof demoUrl === 'string') {
      try { new URL(demoUrl) } catch { return NextResponse.json({ error: 'demoUrl must be a valid URL' }, { status: 400 }) }
    }
    if (!Array.isArray(features) || features.length === 0) {
      return NextResponse.json({ error: 'At least one feature is required' }, { status: 400 })
    }
    if (!Array.isArray(tags) || tags.length === 0) {
      return NextResponse.json({ error: 'At least one tag is required' }, { status: 400 })
    }

    const slug = slugify(name)
    // Check slug uniqueness
    const existing = await db.template.findUnique({ where: { slug } })
    if (existing) {
      return NextResponse.json({ error: 'A template with this name already exists. Choose a different name.' }, { status: 409 })
    }

    // ── Create the template (status: pending) ───────────────────────────
    const template = await db.template.create({
      data: {
        name: name.trim(),
        slug,
        description: description.trim(),
        category,
        framework,
        icon: icon || '📦',
        repoUrl,
        demoUrl: demoUrl || null,
        features: JSON.stringify(features.slice(0, 20)),
        tags: JSON.stringify(tags.slice(0, 15)),
        readme: readme || null,
        license: VALID_LICENSES.includes(license) ? license : 'MIT',
        author: decoded.email,
        submittedById: decoded.userId,
        status: 'pending',
        isOfficial: false,
        previewGradient: 'from-indigo-500 to-purple-600',
      },
    })

    // Audit log
    await logAudit({
      userId: decoded.userId,
      action: 'template.submit',
      resource: 'template',
      resourceId: template.id,
      req: request,
      metadata: { name: template.name, slug: template.slug, category, framework },
    })

    return NextResponse.json({
      template: {
        id: template.id,
        name: template.name,
        slug: template.slug,
        status: template.status,
      },
      message: 'Template submitted! An admin will review it before it appears in the marketplace.',
    }, { status: 201 })
  } catch (error) {
    console.error('[templates/submit] error:', error)
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 })
  }
}
