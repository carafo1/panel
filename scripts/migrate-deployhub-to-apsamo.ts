/**
 * migrate-deployhub-to-apsamo.ts
 *
 * One-time database migration: updates all stored "DeployHub" string values
 * to "APSAMO" across all relevant Prisma tables.
 *
 * Why this exists:
 *   Previous tasks (3-a through 4-a) migrated code-level strings
 *   (UI text, email templates, comments, TOTP issuer, User-Agent, etc.).
 *   This script handles the *database-stored* identifiers that were written
 *   to the DB by old code and need to be aligned with the new "APSAMO"
 *   brand for consistency with the migrated code.
 *
 * What it touches (per Task 4-b spec):
 *   - Domain.registrar       : exact equality 'DeployHub'  -> 'APSAMO'
 *   - Domain.provider        : exact equality 'deployhub'  -> 'apsamo'  (lowercase
 *                              variant — Domain.provider is the actual field that
 *                              stores the value 'deployhub' per the schema comment;
 *                              task 4-a worklog explicitly anticipates this migration)
 *   - AutomationLog.title    : contains 'DeployHub' -> 'APSAMO'  (field does not
 *                              exist in current schema — gracefully skipped)
 *   - AutomationLog.message  : contains 'DeployHub' -> 'APSAMO'  (field does not
 *                              exist — gracefully skipped)
 *   - AuditLog.action        : contains 'DeployHub' -> 'APSAMO'  (no matches in DB
 *                              at migration time — updateMany runs but updates 0)
 *   - Payment.description    : contains 'DeployHub' -> 'APSAMO'  (field does not
 *                              exist — gracefully skipped)
 *   - Notification.title     : contains 'DeployHub' -> 'APSAMO'  (real matches:
 *                              'Welcome to DeployHub!' -> 'Welcome to APSAMO!')
 *   - Notification.message   : contains 'DeployHub' -> 'APSAMO'  (only lowercase
 *                              'deployhub' appears in URL hostnames; case-sensitive
 *                              replace preserves DNS hostnames)
 *   - Template.author        : exact equality 'DeployHub' -> 'APSAMO'  (already
 *                              migrated by prior task — updateMany runs but updates 0)
 *   - PaymentMethod.accountName / .description : model does not exist — skipped
 *
 * What it does NOT touch (per Task 4-b spec, "do not touch" list):
 *   - User.email like admin@deployhub.io / *@deployhub.io  (functional mailboxes)
 *   - Server.hostname / Server.ipAddress                   (infrastructure)
 *   - Project.subdomain / Project.customDomain             (real DNS hostnames)
 *   - Domain.name                                           (user-registered domains)
 *   - Webhook.url                                           (user-configured URLs)
 *   - Project.repoUrl                                       (GitHub repo URLs)
 *   - AuditLog.metadata (implicitly)                        (contains functional
 *      mailbox addresses and *.deployhub.io DNS hostnames — preserved)
 *   - AutomationLog.output                                  (contains *.deployhub.io
 *      deployment URLs — preserved)
 *   - Deployment.deployUrl                                  (contains *.deployhub.io
 *      DNS hostnames — preserved)
 *
 * Approach:
 *   - Direct equality updates use Prisma's `updateMany` with a `where` clause.
 *   - Substring ("contains") updates fetch matching records, transform in JS
 *     with case-sensitive String.replaceAll('DeployHub', 'APSAMO'), and
 *     update one-by-one. Case-sensitivity is intentional — it preserves
 *     lowercase `deployhub` substrings that appear inside DNS hostnames
 *     (e.g. `myapp.deployhub.io`) and email addresses (e.g. `admin@deployhub.io`).
 *   - Each step is wrapped in try/catch so that non-existent fields/models
 *     (e.g. AutomationLog.title, PaymentMethod) are logged and skipped
 *     rather than crashing the whole migration.
 *
 * Re-runnable: idempotent — running it again will match 0 records.
 *
 * Usage:
 *   cd /home/z/my-project && bun run scripts/migrate-deployhub-to-apsamo.ts
 */

import { db } from '../src/lib/db'

// Helper: extract the first non-empty line of an error message (Prisma
// validation errors often begin with a newline followed by a verbose trace).
function firstErrLine(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return raw.substring(0, 120)
}

// Helper: replace 'DeployHub' with 'APSAMO' (case-sensitive) only.
// Lowercase 'deployhub' is intentionally preserved because it appears inside
// DNS hostnames (e.g. `app.deployhub.io`) and email addresses (e.g.
// `admin@deployhub.io`) which must remain functional.
function replaceBrand(s: string | null | undefined): string | null | undefined {
  if (s == null) return s
  return s.split('DeployHub').join('APSAMO')
}

interface StepResult {
  step: string
  table: string
  field: string
  matched: number
  updated: number
  note?: string
}

async function migrate(): Promise<void> {
  console.log('=== DeployHub -> APSAMO DB migration ===')
  console.log('Time:', new Date().toISOString())
  console.log()

  const results: StepResult[] = []

  // ──────────────────────────────────────────────────────────────────────
  // 1. Domain.registrar  — exact equality 'DeployHub' -> 'APSAMO'
  // ──────────────────────────────────────────────────────────────────────
  try {
    const r = await db.domain.updateMany({
      where: { registrar: 'DeployHub' },
      data: { registrar: 'APSAMO' },
    })
    results.push({ step: '1', table: 'Domain', field: 'registrar', matched: r.count, updated: r.count })
    console.log(`[1] Domain.registrar 'DeployHub' -> 'APSAMO': ${r.count} updated`)
  } catch (e) {
    const msg = firstErrLine(e)
    results.push({ step: '1', table: 'Domain', field: 'registrar', matched: 0, updated: 0, note: `skipped: ${msg.substring(0, 120)}` })
    console.log(`[1] Domain.registrar skipped: ${msg.substring(0, 120)}`)
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1b. Domain.provider  — exact equality 'deployhub' -> 'apsamo' (lowercase)
  //   The Domain.provider field (NOT registrar) is the one that stores the
  //   lowercase value 'deployhub' per the schema comment
  //   `// "deployhub", "dynadot"`. Task 4-a worklog explicitly anticipates
  //   this migration: "L65 inline comment: `// "dynadot" or "deployhub"` ->
  //   `// "dynadot" or "apsamo"` (lowercase, matches DB field value after
  //   Task 4-b migration)."
  // ──────────────────────────────────────────────────────────────────────
  try {
    const rLower = await db.domain.updateMany({
      where: { provider: 'deployhub' },
      data: { provider: 'apsamo' },
    })
    results.push({ step: '1b', table: 'Domain', field: 'provider', matched: rLower.count, updated: rLower.count })
    console.log(`[1b] Domain.provider 'deployhub' -> 'apsamo': ${rLower.count} updated`)

    // Also handle capitalized 'DeployHub' just in case (defensive — 0 expected)
    const rCap = await db.domain.updateMany({
      where: { provider: 'DeployHub' },
      data: { provider: 'APSAMO' },
    })
    if (rCap.count > 0) {
      results.push({ step: '1b-cap', table: 'Domain', field: 'provider', matched: rCap.count, updated: rCap.count })
      console.log(`[1b-cap] Domain.provider 'DeployHub' -> 'APSAMO': ${rCap.count} updated`)
    }
  } catch (e) {
    const msg = firstErrLine(e)
    results.push({ step: '1b', table: 'Domain', field: 'provider', matched: 0, updated: 0, note: `skipped: ${msg.substring(0, 120)}` })
    console.log(`[1b] Domain.provider skipped: ${msg.substring(0, 120)}`)
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2. AutomationLog.title / .message — contains 'DeployHub' -> 'APSAMO'
  //   NOTE: AutomationLog schema has fields {action, eventType, input, output,
  //   error} — there is no `title` or `message` field. The task spec lists
  //   these fields but they don't exist; we attempt them anyway inside
  //   try/catch so the migration logs "skipped" and continues.
  //   The actual DeployHub references in AutomationLog are in `output` JSON
  //   strings containing deployment URLs (https://app.deployhub.io) — these
  //   are DNS hostnames and are PRESERVED per task spec.
  // ──────────────────────────────────────────────────────────────────────
  try {
    const logs = await db.automationLog.findMany({
      where: {
        OR: [
          { title: { contains: 'DeployHub' } },
          { message: { contains: 'DeployHub' } },
        ],
      },
      select: { id: true, title: true, message: true },
    })
    let count = 0
    for (const log of logs) {
      const newTitle = replaceBrand(log.title)
      const newMessage = replaceBrand(log.message)
      // Skip no-op writes (Prisma contains is case-insensitive on SQLite,
      // so a record with lowercase 'deployhub' in a URL would match but
      // case-sensitive replaceBrand returns the same string — skip it).
      if (newTitle === log.title && newMessage === log.message) continue
      await db.automationLog.update({
        where: { id: log.id },
        data: {
          title: newTitle,
          message: newMessage,
        },
      })
      count++
    }
    results.push({ step: '2', table: 'AutomationLog', field: 'title/message', matched: logs.length, updated: count })
    console.log(`[2] AutomationLog.title/message 'DeployHub' -> 'APSAMO': matched=${logs.length} updated=${count}`)
  } catch (e) {
    const msg = firstErrLine(e)
    results.push({ step: '2', table: 'AutomationLog', field: 'title/message', matched: 0, updated: 0, note: `skipped (fields do not exist in schema): ${msg.substring(0, 120)}` })
    console.log(`[2] AutomationLog.title/message skipped (fields do not exist in schema): ${msg.substring(0, 120)}`)
  }

  // ──────────────────────────────────────────────────────────────────────
  // 3. AuditLog.action — contains 'DeployHub' -> 'APSAMO'
  //   Discovery found 0 matches in `action` (all 50 AuditLog matches are in
  //   `metadata`, which contains functional mailboxes + DNS hostnames that
  //   must be preserved). updateMany still runs for safety.
  // ──────────────────────────────────────────────────────────────────────
  try {
    const logs = await db.auditLog.findMany({
      where: { action: { contains: 'DeployHub' } },
      select: { id: true, action: true },
    })
    let count = 0
    for (const log of logs) {
      const newAction = replaceBrand(log.action) ?? log.action
      if (newAction === log.action) continue
      await db.auditLog.update({
        where: { id: log.id },
        data: { action: newAction },
      })
      count++
    }
    results.push({ step: '3', table: 'AuditLog', field: 'action', matched: logs.length, updated: count })
    console.log(`[3] AuditLog.action 'DeployHub' -> 'APSAMO': matched=${logs.length} updated=${count}`)
  } catch (e) {
    const msg = firstErrLine(e)
    results.push({ step: '3', table: 'AuditLog', field: 'action', matched: 0, updated: 0, note: `skipped: ${msg.substring(0, 120)}` })
    console.log(`[3] AuditLog.action skipped: ${msg.substring(0, 120)}`)
  }

  // ──────────────────────────────────────────────────────────────────────
  // 4. Payment.description — contains 'DeployHub' -> 'APSAMO'
  //   NOTE: Payment schema has no `description` field (only type/method/
  //   metadata). Attempted inside try/catch — will be skipped.
  //   Discovery confirmed 0 Payment records contain 'deployhub' anyway.
  // ──────────────────────────────────────────────────────────────────────
  try {
    const pays = await db.payment.findMany({
      where: { description: { contains: 'DeployHub' } },
      select: { id: true, description: true },
    })
    let count = 0
    for (const p of pays) {
      const newDesc = replaceBrand(p.description)
      if (newDesc === p.description) continue
      await db.payment.update({
        where: { id: p.id },
        data: { description: newDesc },
      })
      count++
    }
    results.push({ step: '4', table: 'Payment', field: 'description', matched: pays.length, updated: count })
    console.log(`[4] Payment.description 'DeployHub' -> 'APSAMO': matched=${pays.length} updated=${count}`)
  } catch (e) {
    const msg = firstErrLine(e)
    results.push({ step: '4', table: 'Payment', field: 'description', matched: 0, updated: 0, note: `skipped (field does not exist in schema): ${msg.substring(0, 120)}` })
    console.log(`[4] Payment.description skipped (field does not exist in schema): ${msg.substring(0, 120)}`)
  }

  // ──────────────────────────────────────────────────────────────────────
  // 5. Notification.title — contains 'DeployHub' -> 'APSAMO'
  //   Discovery found 4 records with title 'Welcome to DeployHub!' — these
  //   are user-facing brand strings, safe to migrate.
  // ──────────────────────────────────────────────────────────────────────
  try {
    const notifs = await db.notification.findMany({
      where: { title: { contains: 'DeployHub' } },
      select: { id: true, title: true },
    })
    let count = 0
    for (const n of notifs) {
      const newTitle = replaceBrand(n.title) ?? n.title
      if (newTitle === n.title) continue
      await db.notification.update({
        where: { id: n.id },
        data: { title: newTitle },
      })
      count++
    }
    results.push({ step: '5', table: 'Notification', field: 'title', matched: notifs.length, updated: count })
    console.log(`[5] Notification.title 'DeployHub' -> 'APSAMO': matched=${notifs.length} updated=${count}`)
  } catch (e) {
    const msg = firstErrLine(e)
    results.push({ step: '5', table: 'Notification', field: 'title', matched: 0, updated: 0, note: `skipped: ${msg.substring(0, 120)}` })
    console.log(`[5] Notification.title skipped: ${msg.substring(0, 120)}`)
  }

  // ──────────────────────────────────────────────────────────────────────
  // 6. Notification.message — contains 'DeployHub' -> 'APSAMO'
  //   Discovery found 8 records with messages like
  //   'Your deployment is now live at https://app.deployhub.io'.
  //   These contain LOWERCASE 'deployhub' inside DNS hostname URLs.
  //   Prisma's `contains` is case-insensitive on SQLite, so the query
  //   matches these records — but case-sensitive replaceBrand returns the
  //   same string, so the no-op-skip logic above preserves the DNS
  //   hostnames (matches the task spec rule "do not touch *.deployhub.io
  //   DNS hostnames"). Expected updated count: 0 (only URL hostnames
  //   present, no capitalized 'DeployHub' brand text in messages).
  // ──────────────────────────────────────────────────────────────────────
  try {
    const notifs = await db.notification.findMany({
      where: { message: { contains: 'DeployHub' } },
      select: { id: true, message: true },
    })
    let count = 0
    for (const n of notifs) {
      const newMessage = replaceBrand(n.message) ?? n.message
      if (newMessage === n.message) continue
      await db.notification.update({
        where: { id: n.id },
        data: { message: newMessage },
      })
      count++
    }
    results.push({ step: '6', table: 'Notification', field: 'message', matched: notifs.length, updated: count })
    console.log(`[6] Notification.message 'DeployHub' -> 'APSAMO': matched=${notifs.length} updated=${count} (case-sensitive — lowercase 'deployhub' in DNS URLs is preserved)`)
  } catch (e) {
    const msg = firstErrLine(e)
    results.push({ step: '6', table: 'Notification', field: 'message', matched: 0, updated: 0, note: `skipped: ${msg.substring(0, 120)}` })
    console.log(`[6] Notification.message skipped: ${msg.substring(0, 120)}`)
  }

  // ──────────────────────────────────────────────────────────────────────
  // 7. Template.author — exact equality 'DeployHub' -> 'APSAMO'
  //   Discovery found 0 matches (Template.author was already migrated by a
  //   prior task). updateMany still runs for safety.
  // ──────────────────────────────────────────────────────────────────────
  try {
    const r = await db.template.updateMany({
      where: { author: 'DeployHub' },
      data: { author: 'APSAMO' },
    })
    results.push({ step: '7', table: 'Template', field: 'author', matched: r.count, updated: r.count })
    console.log(`[7] Template.author 'DeployHub' -> 'APSAMO': ${r.count} updated`)
  } catch (e) {
    const msg = firstErrLine(e)
    results.push({ step: '7', table: 'Template', field: 'author', matched: 0, updated: 0, note: `skipped: ${msg.substring(0, 120)}` })
    console.log(`[7] Template.author skipped: ${msg.substring(0, 120)}`)
  }

  // ──────────────────────────────────────────────────────────────────────
  // 8. PaymentMethod.accountName / .description — contains 'DeployHub'
  //   NOTE: There is no `PaymentMethod` model in the schema (only
  //   `PaymentMethodSetting` — different shape). Attempted inside try/catch
  //   — will be skipped.
  // ──────────────────────────────────────────────────────────────────────
  try {
    const dbAny = db as unknown as Record<string, unknown> & { paymentMethod?: { findMany: (args: unknown) => Promise<unknown[]>; update: (args: unknown) => Promise<unknown> } }
    if (typeof dbAny.paymentMethod?.findMany !== 'function') {
      throw new Error('db.paymentMethod model does not exist in schema')
    }
    const pms = (await dbAny.paymentMethod.findMany({
      where: {
        OR: [
          { accountName: { contains: 'DeployHub' } },
          { description: { contains: 'DeployHub' } },
        ],
      },
      select: { id: true, accountName: true, description: true },
    })) as Array<{ id: string; accountName: string | null; description: string | null }>
    let count = 0
    for (const pm of pms) {
      const newName = replaceBrand(pm.accountName)
      const newDesc = replaceBrand(pm.description)
      if (newName === pm.accountName && newDesc === pm.description) continue
      await dbAny.paymentMethod.update({
        where: { id: pm.id },
        data: {
          accountName: newName,
          description: newDesc,
        },
      })
      count++
    }
    results.push({ step: '8', table: 'PaymentMethod', field: 'accountName/description', matched: pms.length, updated: count })
    console.log(`[8] PaymentMethod.accountName/description 'DeployHub' -> 'APSAMO': matched=${pms.length} updated=${count}`)
  } catch (e) {
    const msg = firstErrLine(e)
    results.push({ step: '8', table: 'PaymentMethod', field: 'accountName/description', matched: 0, updated: 0, note: `skipped (model does not exist in schema): ${msg.substring(0, 120)}` })
    console.log(`[8] PaymentMethod.accountName/description skipped (model does not exist in schema): ${msg.substring(0, 120)}`)
  }

  // ──────────────────────────────────────────────────────────────────────
  // Final summary
  // ──────────────────────────────────────────────────────────────────────
  console.log()
  console.log('=== Migration summary ===')
  let totalMatched = 0
  let totalUpdated = 0
  for (const r of results) {
    totalMatched += r.matched
    totalUpdated += r.updated
    const note = r.note ? `  [${r.note}]` : ''
    console.log(`  [${r.step}] ${r.table}.${r.field}: matched=${r.matched} updated=${r.updated}${note}`)
  }
  console.log(`  TOTAL: matched=${totalMatched} updated=${totalUpdated}`)
  console.log()
  console.log('Done.')
}

migrate()
  .then(() => {
    void db.$disconnect()
    process.exit(0)
  })
  .catch((e) => {
    console.error('Migration failed:', e)
    void db.$disconnect()
    process.exit(1)
  })
