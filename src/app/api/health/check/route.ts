import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runHealthChecks } from '@/lib/health'
import { sendEmail } from '@/lib/email'
import { createNotification } from '@/lib/notifications'
import { requireAdminRole } from '@/lib/auth'
import { ADMIN_EMAIL, FROM_NAME } from '@/lib/brand-config'

/**
 * Health check + alerting.
 *
 * Called by an OS-level cron, deliberately NOT by the worker: the worker is
 * one of the things being checked, and a monitor that dies with the thing it
 * monitors is not a monitor.
 *
 * Alerts fire on STATE CHANGE only — a newly failing check, or a recovery.
 * Re-sending "billing sweep is down" every 15 minutes for a week trains the
 * operator to filter the alerts, which is worse than not sending them.
 */
const CRON_API_KEY =
  process.env.CRON_API_KEY &&
  !/^deployhub-cron-key$|^replace-with/.test(process.env.CRON_API_KEY)
    ? process.env.CRON_API_KEY
    : null

const ALERT_STATE_KEY = '__alert_state'

async function authorise(request: Request): Promise<boolean> {
  const cronKey = request.headers.get('x-cron-key')
  if (CRON_API_KEY && cronKey && cronKey === CRON_API_KEY) return true
  return Boolean(await requireAdminRole(request))
}

/**
 * In-app alert to every active admin. Deliberately independent of email so a
 * mail outage — or a placeholder SMTP password — cannot hide an incident.
 */
async function notifyAdminsInApp(title: string, message: string): Promise<void> {
  try {
    const admins = await db.user.findMany({
      where: { role: { in: ['admin', 'super_admin'] }, status: 'active' },
      select: { id: true },
    })
    await Promise.all(
      admins.map((a) =>
        createNotification({
          userId: a.id,
          title: `[System] ${title}`,
          message,
          type: 'error',
          link: '/?tab=admin',
        }).catch(() => {})
      )
    )
  } catch (err) {
    console.error('[health] in-app alert failed:', err)
  }
}

/** Previously-failing check keys, so we only alert on transitions. */
async function loadPreviousFailures(): Promise<string[]> {
  const row = await db.heartbeat
    .findUnique({ where: { key: ALERT_STATE_KEY } })
    .catch(() => null)
  if (!row?.detail) return []
  try {
    const parsed = JSON.parse(row.detail) as unknown
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

async function savePreviousFailures(keys: string[]): Promise<void> {
  await db.heartbeat
    .upsert({
      where: { key: ALERT_STATE_KEY },
      create: { key: ALERT_STATE_KEY, detail: JSON.stringify(keys) },
      update: { detail: JSON.stringify(keys) },
    })
    .catch(() => {})
}

export async function POST(request: Request) {
  try {
    if (!(await authorise(request))) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 403 })
    }

    const report = await runHealthChecks()
    const nowFailing = report.failing.map((c) => c.key)
    const wasFailing = await loadPreviousFailures()

    const newlyBroken = report.failing.filter((c) => !wasFailing.includes(c.key))
    const recovered = wasFailing.filter((k) => !nowFailing.includes(k))

    let alerted = false
    const to = process.env.ALERT_EMAIL || ADMIN_EMAIL

    if (newlyBroken.length > 0) {
      const rows = newlyBroken
        .map(
          (c) =>
            `<li><strong>${c.label}</strong><br/>${c.detail}${
              c.remedy ? `<br/><em>${c.remedy}</em>` : ''
            }</li>`
        )
        .join('')
      await sendEmail({
        to,
        subject: `[Apsamo] ${newlyBroken.length} system check(s) failing`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6">
<p>The following checks started failing:</p>
<ul>${rows}</ul>
<p style="color:#6b7280;font-size:13px">Checked at ${report.at}. You will not be
emailed again about these until they recover and fail anew.<br/>— ${FROM_NAME}</p>
</div>`,
      }).catch((err) => console.error('[health] alert email failed:', err))

      // ALSO notify in-app. Email is itself one of the things that can be
      // broken — and when it is, an email-only alert about it can never
      // arrive. The in-app copy is the one that survives that case.
      await notifyAdminsInApp(
        `${newlyBroken.length} system check(s) failing`,
        newlyBroken.map((c) => `${c.label}: ${c.detail}`).join(' — ')
      )

      alerted = true
      console.error(
        '[health] ALERT:',
        newlyBroken.map((c) => `${c.key}: ${c.detail}`).join(' | ')
      )
    }

    if (recovered.length > 0) {
      await sendEmail({
        to,
        subject: `[Apsamo] ${recovered.length} system check(s) recovered`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6">
<p>Back to normal: <strong>${recovered.join(', ')}</strong>.</p>
<p style="color:#6b7280;font-size:13px">Checked at ${report.at}.<br/>— ${FROM_NAME}</p>
</div>`,
      }).catch(() => {})
      alerted = true
      console.log('[health] RECOVERED:', recovered.join(', '))
    }

    await savePreviousFailures(nowFailing)

    return NextResponse.json({
      status: report.status,
      checks: report.checks.length,
      failing: nowFailing,
      newlyBroken: newlyBroken.map((c) => c.key),
      recovered,
      alerted,
      at: report.at,
    })
  } catch (error) {
    console.error('[health/check] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** GET → the full report, no alerting side-effects. */
export async function GET(request: Request) {
  try {
    if (!(await authorise(request))) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 403 })
    }
    return NextResponse.json(await runHealthChecks())
  } catch (error) {
    console.error('[health/check] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
