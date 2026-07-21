/**
 * System health checks.
 *
 * Written after three failures that ran silently for days: a billing sweep
 * that filtered out every subscription, a provisioner that only pretended to
 * build things, and a worker that could not reach the panel at all. In each
 * case every service reported "active" and nobody found out until someone
 * went looking.
 *
 * The rule this file follows: a check must observe an OUTCOME, not a status.
 * "The worker process exists" is worthless. "A billing sweep completed within
 * the last 2 hours" is a fact you can act on.
 */
import { db } from '@/lib/db'
import { promises as fs } from 'fs'
import path from 'path'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown'

export interface HealthCheck {
  key: string
  label: string
  status: CheckStatus
  detail: string
  /** Suggested action when not ok — an alert nobody can act on is noise. */
  remedy?: string
}

export interface HealthReport {
  status: CheckStatus
  checks: HealthCheck[]
  failing: HealthCheck[]
  at: string
}

const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/apsamo/backups'

/**
 * Expected cadence per heartbeat, with the grace we allow before complaining.
 * Generous multiples of the real interval: a single slow tick is not an
 * incident, and an alert that cries wolf gets muted, which is worse than no
 * alert at all.
 */
const BEATS: Array<{ key: string; label: string; maxAgeMs: number; remedy: string }> = [
  {
    key: 'jobs',
    label: 'Job queue processing',
    maxAgeMs: 15 * 60_000, // ticks every 10s
    remedy:
      'Check the worker can reach the panel: tail /opt/apsamo/logs/worker.log (NOT journalctl — it logs to a file).',
  },
  {
    key: 'monitors',
    label: 'Uptime monitors',
    maxAgeMs: 30 * 60_000, // ticks every 60s
    remedy: 'Check /opt/apsamo/logs/worker.log for /api/monitors/run failures.',
  },
  {
    key: 'billing',
    label: 'Billing sweep',
    maxAgeMs: 3 * 60 * 60_000, // ticks hourly
    remedy:
      'Renewals, expiry and suspensions are not running. Check the worker and CRON_API_KEY.',
  },
]

function ageText(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Record a successful background tick. */
export async function recordHeartbeat(
  key: string,
  detail?: string
): Promise<void> {
  try {
    await db.heartbeat.upsert({
      where: { key },
      create: { key, detail: detail?.slice(0, 500) || null, failures: 0 },
      update: {
        detail: detail?.slice(0, 500) || null,
        failures: 0,
        lastError: null,
      },
    })
  } catch (err) {
    // Never let telemetry break the work it is measuring.
    console.error('[health] recordHeartbeat failed:', err)
  }
}

/** Record a failed tick, keeping a consecutive-failure count. */
export async function recordHeartbeatFailure(
  key: string,
  error: string
): Promise<void> {
  try {
    await db.heartbeat.upsert({
      where: { key },
      create: { key, failures: 1, lastError: error.slice(0, 500) },
      update: { failures: { increment: 1 }, lastError: error.slice(0, 500) },
    })
  } catch (err) {
    console.error('[health] recordHeartbeatFailure failed:', err)
  }
}

export async function runHealthChecks(): Promise<HealthReport> {
  const checks: HealthCheck[] = []
  const now = Date.now()

  // ── Background work actually happening ────────────────────────────
  const beats = await db.heartbeat.findMany().catch(() => [])
  for (const spec of BEATS) {
    const beat = beats.find((b) => b.key === spec.key)
    if (!beat) {
      checks.push({
        key: `beat.${spec.key}`,
        label: spec.label,
        status: 'fail',
        detail: 'Has never reported a successful run.',
        remedy: spec.remedy,
      })
      continue
    }
    const age = now - new Date(beat.at).getTime()
    if (beat.failures > 0) {
      checks.push({
        key: `beat.${spec.key}`,
        label: spec.label,
        status: 'fail',
        detail: `${beat.failures} consecutive failure(s). Last error: ${beat.lastError || 'unknown'}`,
        remedy: spec.remedy,
      })
    } else if (age > spec.maxAgeMs) {
      checks.push({
        key: `beat.${spec.key}`,
        label: spec.label,
        status: 'fail',
        detail: `Last successful run ${ageText(age)} — expected within ${Math.round(spec.maxAgeMs / 60_000)}m.`,
        remedy: spec.remedy,
      })
    } else {
      checks.push({
        key: `beat.${spec.key}`,
        label: spec.label,
        status: 'ok',
        detail: `Last run ${ageText(age)}. ${beat.detail || ''}`.trim(),
      })
    }
  }

  // ── Backups ───────────────────────────────────────────────────────
  try {
    const files = (await fs.readdir(BACKUP_DIR)).filter(
      (f) => f.startsWith('apsamo-backup-') && f.endsWith('.tar.gz')
    )
    if (files.length === 0) {
      checks.push({
        key: 'backup.local',
        label: 'Local backups',
        status: 'fail',
        detail: 'No backup archives found.',
        remedy: 'Check the 03:00 cron job /usr/local/bin/apsamo-full-backup.sh.',
      })
    } else {
      const stats = await Promise.all(
        files.map(async (f) => ({
          f,
          m: (await fs.stat(path.join(BACKUP_DIR, f))).mtime.getTime(),
        }))
      )
      const newest = stats.sort((a, b) => b.m - a.m)[0]
      const age = now - newest.m
      checks.push({
        key: 'backup.local',
        label: 'Local backups',
        status: age > 48 * 3_600_000 ? 'fail' : 'ok',
        detail: `${files.length} archive(s), newest ${ageText(age)}.`,
        remedy:
          age > 48 * 3_600_000
            ? 'The nightly backup has not run for over 48h.'
            : undefined,
      })
    }

    const raw = await fs
      .readFile(path.join(BACKUP_DIR, '.offsite-status.json'), 'utf8')
      .catch(() => null)
    const offsite = raw ? (JSON.parse(raw) as { state: string; detail: string }) : null
    checks.push({
      key: 'backup.offsite',
      label: 'Offsite replication',
      // Deliberately 'warn', not 'fail': unconfigured is a decision the
      // operator has not made yet, not a system malfunction. It still must
      // be visible on every report.
      status: offsite?.state === 'ok' ? 'ok' : 'warn',
      detail: offsite?.detail || 'Never reported.',
      remedy:
        offsite?.state === 'ok'
          ? undefined
          : 'Backups exist only on this VPS. Configure /etc/apsamo/offsite.env.',
    })
  } catch {
    checks.push({
      key: 'backup.local',
      label: 'Local backups',
      status: 'unknown',
      detail: `Cannot read ${BACKUP_DIR}.`,
    })
  }

  // ── Can we actually take money? ───────────────────────────────────
  try {
    const { getAllGatewayStatuses } = await import('@/lib/gateways')
    const { getAllPaymentMethods } = await import('@/lib/payment-methods')
    const statuses = getAllGatewayStatuses()
    const methods = await getAllPaymentMethods().catch(() => [])
    const liveEnabled = statuses.filter((g) => {
      const m = methods.find((x) => x.method === g.id)
      return m?.active && g.usable && (g.mode === 'live' || g.mode === 'n/a')
    })
    const testEnabled = statuses.filter((g) => {
      const m = methods.find((x) => x.method === g.id)
      return m?.active && g.mode === 'test'
    })
    checks.push({
      key: 'payments',
      label: 'Payment gateways',
      status: liveEnabled.length > 0 ? 'ok' : 'fail',
      detail:
        liveEnabled.length > 0
          ? `${liveEnabled.map((g) => g.id).join(', ')} can take live payments.${
              testEnabled.length
                ? ` (${testEnabled.map((g) => g.id).join(', ')} in TEST mode.)`
                : ''
            }`
          : 'No enabled gateway can take real money.',
      remedy:
        liveEnabled.length > 0
          ? undefined
          : 'Enable a configured gateway, or swap test keys for live ones.',
    })
  } catch {
    /* gateway registry unavailable — not fatal to the rest of the report */
  }

  // ── Email deliverability ──────────────────────────────────────────
  // Every sendEmail() call site is .catch()-swallowed so a mail failure can
  // never break billing. The cost of that choice is that broken mail is
  // completely silent: invoices, payment receipts, password resets and the
  // alert emails from THIS file all vanish without a trace. So check the
  // configuration explicitly.
  {
    const host = process.env.SMTP_HOST || ''
    const pass = process.env.SMTP_PASS || ''
    const isPlaceholder = (v: string) =>
      /^(replace[-_ ]?with|your[-_ ]|changeme|xxx+)/i.test(v.trim())

    // Mirror sendEmail's ACTUAL precedence: an HTTP API provider wins and SMTP
    // is never consulted. Checking SMTP first reported "no email is being
    // delivered" on a box that sends fine over the Resend API — a check that
    // describes a code path the app doesn't take is worse than no check.
    const provider = (process.env.EMAIL_PROVIDER || '').toLowerCase().trim()
    const apiKey = process.env.EMAIL_API_KEY || process.env.RESEND_API_KEY || ''

    if (provider && apiKey && !isPlaceholder(apiKey)) {
      checks.push({
        key: 'email',
        label: 'Email delivery',
        status: 'ok',
        detail: `Sending via the ${provider} HTTP API (SMTP settings are unused on this path).`,
      })
    } else if (provider && (!apiKey || isPlaceholder(apiKey))) {
      checks.push({
        key: 'email',
        label: 'Email delivery',
        status: 'fail',
        detail: `EMAIL_PROVIDER=${provider} but EMAIL_API_KEY is missing or a placeholder, and sendEmail prefers this path over SMTP.`,
        remedy: 'Set a real EMAIL_API_KEY, or clear EMAIL_PROVIDER to fall back to SMTP.',
      })
    } else if (!host) {
      checks.push({
        key: 'email',
        label: 'Email delivery',
        status: 'fail',
        detail: 'No SMTP_HOST and no RESEND_API_KEY — all mail is discarded.',
        remedy: 'Set SMTP_HOST/SMTP_USER/SMTP_PASS, or RESEND_API_KEY.',
      })
    } else if (!pass || isPlaceholder(pass)) {
      checks.push({
        key: 'email',
        label: 'Email delivery',
        status: 'fail',
        detail: `SMTP_PASS is unset or still a placeholder — ${host} rejects the login, so NO email is being delivered (invoices, receipts, password resets, and these alerts).`,
        remedy: `Set a real SMTP_PASS for ${process.env.SMTP_USER || 'the SMTP user'} in /opt/apsamo/.env and restart the panel.`,
      })
    } else {
      checks.push({
        key: 'email',
        label: 'Email delivery',
        status: 'ok',
        detail: `SMTP configured (${host}).`,
      })
    }
  }

  // ── Stuck provisioning ────────────────────────────────────────────
  try {
    const stuck = await db.provisioningJob.count({
      where: {
        status: { in: ['pending', 'running'] },
        createdAt: { lt: new Date(now - 2 * 3_600_000) },
      },
    })
    checks.push({
      key: 'provisioning',
      label: 'Provisioning queue',
      status: stuck > 0 ? 'fail' : 'ok',
      detail:
        stuck > 0
          ? `${stuck} job(s) stuck in pending/running for over 2h.`
          : 'No stuck jobs.',
      remedy: stuck > 0 ? 'A customer has paid and is not being served.' : undefined,
    })
  } catch {
    /* table may not exist in older installs */
  }

  const failing = checks.filter((c) => c.status === 'fail')
  const warned = checks.filter((c) => c.status === 'warn')

  return {
    status: failing.length > 0 ? 'fail' : warned.length > 0 ? 'warn' : 'ok',
    checks,
    failing,
    at: new Date().toISOString(),
  }
}
