import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { isValidEnvKey, ENV_KEY_ERROR } from '@/lib/safe-values'
import { parseDotenv } from '@/lib/dotenv-parse'

/** Enough for any real application; stops an import filling the table. */
const MAX_ENV_VARS = 500
import { encrypt, decrypt } from '@/lib/encryption'
import { logAudit } from '@/lib/audit'

/**
 * Mask a sensitive value for display.
 * Shows the first 2 characters followed by `****`
 * (e.g. `sk-abc123` -> `sk****`).
 *
 * For values shorter than 3 chars, we fully mask them
 * so as not to leak the entire secret.
 */
function maskValue(value: string): string {
  if (!value) return '****'
  if (value.length <= 2) return '****'
  return value.slice(0, 2) + '****'
}

/**
 * Decrypt a stored env var value if it is marked as encrypted.
 * Legacy (unencrypted) values are returned as-is.
 *
 * Failures are logged and we fall back to the raw stored value
 * so the UI can still render the row instead of erroring out.
 */
function revealValue(stored: string, encrypted: boolean): string {
  if (!encrypted) return stored
  try {
    return decrypt(stored)
  } catch (err) {
    console.error('[env] Failed to decrypt value, returning raw:', err)
    return stored
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id: projectId } = await params

    // Values are secrets, so reading them needs the same permission as writing.
    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response

    const project = await db.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    const envVars = await db.environmentVariable.findMany({
      where: { projectId },
      orderBy: { key: 'asc' },
    })

    // Check if the request wants unmasked (decrypted) values (via query param)
    const url = new URL(request.url)
    const reveal = url.searchParams.get('reveal') === 'true'

    // Has anything changed since the container was last built from these?
    //
    // Environment variables only reach the container when docker-compose.yml is
    // regenerated, so editing one and doing nothing else leaves the running app
    // on the old values — with no sign anything is pending. That is exactly how
    // a site ended up serving 503s after a .env import: 29 variables saved, and
    // a container that still had two.
    //
    // Comparing timestamps costs nothing. Asking the server what the container
    // actually has would mean an SSH round trip on every load of this tab.
    const lastApplied = project.lastDeployedAt
    const pending = envVars.filter(
      (v) => !lastApplied || v.updatedAt > lastApplied
    )

    return NextResponse.json({
      envVars: envVars.map((v) => {
        const plain = revealValue(v.value, v.encrypted)
        return {
          id: v.id,
          key: v.key,
          value: reveal ? plain : maskValue(plain),
          encrypted: v.encrypted,
          createdAt: v.createdAt.toISOString(),
          updatedAt: v.updatedAt.toISOString(),
        }
      }),
      drift: {
        pending: pending.length > 0,
        keys: pending.map((v) => v.key),
        lastAppliedAt: lastApplied ? lastApplied.toISOString() : null,
        // Values compiled into the browser bundle need a real rebuild, not a
        // container recreate — the UI offers the right action for each.
        needsRebuild: pending
          .map((v) => v.key)
          .filter((k) => k.startsWith('NEXT_PUBLIC_')),
      },
    })
  } catch (error) {
    console.error('Get env vars error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id: projectId } = await params
    // Checked before anything else: the .env import branch below used to run
    // before any ownership check at all.
    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    // ── Bulk import from a .env file ────────────────────────────────
    // Sent as text rather than multipart: a .env is text, and one code path
    // is easier to keep correct than two.
    if (body.action === 'import') {
      if (typeof body.content !== 'string' || !body.content.trim()) {
        return NextResponse.json(
          { error: 'Paste the contents of a .env file, or choose one to upload.' },
          { status: 400 }
        )
      }
      if (body.content.length > 512 * 1024) {
        return NextResponse.json(
          { error: 'That file is too large to be a .env (limit 512 KB).' },
          { status: 413 }
        )
      }

      const parsed = parseDotenv(body.content)
      if (parsed.entries.length === 0) {
        return NextResponse.json(
          {
            error: 'No usable KEY=value lines found.',
            invalid: parsed.invalid.slice(0, 20),
          },
          { status: 400 }
        )
      }
      if (parsed.entries.length > MAX_ENV_VARS) {
        return NextResponse.json(
          { error: `That is ${parsed.entries.length} variables; the limit is ${MAX_ENV_VARS}.` },
          { status: 400 }
        )
      }

      const overwrite = body.overwrite !== false // default: update what exists
      const added: string[] = []
      const updated: string[] = []
      const skipped: Array<{ key: string; reason: string }> = []

      for (const entry of parsed.entries) {
        const existing = await db.environmentVariable.findFirst({
          where: { projectId, key: entry.key },
          select: { id: true },
        })
        if (existing) {
          if (!overwrite) {
            skipped.push({ key: entry.key, reason: 'already set' })
            continue
          }
          await db.environmentVariable.update({
            where: { id: existing.id },
            data: { value: encrypt(entry.value), encrypted: true },
          })
          updated.push(entry.key)
        } else {
          await db.environmentVariable.create({
            data: {
              projectId,
              key: entry.key,
              value: encrypt(entry.value),
              encrypted: true,
            },
          })
          added.push(entry.key)
        }
      }

      await logAudit({
        userId: decoded.userId,
        action: 'project.env.import',
        resource: 'project',
        resourceId: projectId,
        req: request,
        metadata: { added: added.length, updated: updated.length, skipped: skipped.length },
      }).catch(() => {})

      return NextResponse.json(
        {
          ok: true,
          added,
          updated,
          skipped,
          invalid: parsed.invalid.slice(0, 20),
          duplicates: parsed.duplicates,
          // The container only picks these up when it is rebuilt.
          message:
            `${added.length} added, ${updated.length} updated. ` +
            `Redeploy the site for the container to pick them up.`,
        },
        { status: 201 }
      )
    }

    const { key, value } = body

    if (!key || typeof key !== 'string' || !key.trim()) {
      return NextResponse.json(
        { error: 'Key is required' },
        { status: 400 }
      )
    }

    // The name is interpolated into docker-compose.yml. Anything outside the
    // POSIX charset -- a newline above all -- lets the customer append
    // arbitrary service properties. See lib/safe-values.
    if (!isValidEnvKey(key.trim())) {
      return NextResponse.json({ error: ENV_KEY_ERROR }, { status: 400 })
    }

    if (value === undefined || value === null || typeof value !== 'string') {
      return NextResponse.json(
        { error: 'Value is required' },
        { status: 400 }
      )
    }

    // Check for duplicate key
    const existing = await db.environmentVariable.findFirst({
      where: { projectId, key: key.trim() },
    })

    if (existing) {
      return NextResponse.json(
        { error: `Environment variable "${key.trim()}" already exists` },
        { status: 409 }
      )
    }

    // Always encrypt the value at rest with AES-256-GCM.
    // The `encrypted` flag is set to true so future reads know
    // to call decrypt() on the stored payload.
    const envVar = await db.environmentVariable.create({
      data: {
        projectId,
        key: key.trim(),
        value: encrypt(value),
        encrypted: true,
      },
    })

    return NextResponse.json({
      envVar: {
        id: envVar.id,
        key: envVar.key,
        value: maskValue(value),
        encrypted: envVar.encrypted,
        createdAt: envVar.createdAt.toISOString(),
        updatedAt: envVar.updatedAt.toISOString(),
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Create env var error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
