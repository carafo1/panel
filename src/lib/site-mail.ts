/**
 * Outgoing mail for customer websites — mailbox lifecycle.
 * ════════════════════════════════════════════════════════════════════════════
 * One Mailcow mailbox per site on the platform sending domain
 * (site-<slug>@<SITE_MAIL_DOMAIN>), its password encrypted in SiteMail.
 * How the site uses it is in lib/site-mail-config.ts.
 *
 * Lifecycle:
 *   deploy (wordpress/php)  ensureSiteMail: create once, repair if Mailcow
 *                           creation failed earlier, never re-enable a site the
 *                           owner switched off
 *   POST enable/disable/rotate/test   /api/hosting/[id]/mail
 *   project delete          removeSiteMail (lib/project-teardown)
 *
 * The password is never logged and never returned by any function here except
 * getSiteMailRuntime, whose output goes into the site's config only.
 */
import crypto from 'crypto'
import nodemailer from 'nodemailer'
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'
import {
  createMailbox,
  updateMailbox,
  deleteMailbox,
  setMailboxRateLimit,
  setMailboxSenderAcl,
  isMailcowConfigured,
  mailcowDemoForbidden,
  friendlyMailcowError,
  MAIL_SERVER_NOT_CONFIGURED,
} from '@/lib/mailcow'
import {
  generateSiteMailPassword,
  isSiteMailMethod,
  siteMailDomain,
  siteMailLocalPart,
  siteMailQuotaMB,
  siteMailRateLimitPerHour,
  siteMailSmtpHost,
  siteMailSmtpPort,
  type SiteMailRuntime,
} from '@/lib/site-mail-config'

export class SiteMailError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

/** Minimum time between two test emails for one site. */
export const TEST_COOLDOWN_MS = 60_000

const newPassword = () => generateSiteMailPassword((max) => crypto.randomInt(max))

function mailcowErrorText(err: string | undefined): string {
  return friendlyMailcowError(err).slice(0, 300)
}

/** Status shape returned to the UI (no secrets). */
export interface SiteMailStatus {
  supported: boolean
  method: string | null
  enabled: boolean
  provisioned: boolean
  address: string | null
  fromAddress: string | null
  fromName: string | null
  smtpHost: string
  smtpPort: number
  rateLimitPerHour: number | null
  lastError: string | null
  lastTest: { at: string; ok: boolean; message: string | null } | null
  /** Domains the owner hosts mail for with us — valid choices for fromAddress. */
  fromDomains: string[]
  /** WordPress applies immediately; PHP needs a redeploy to rebuild msmtp. */
  appliesOn: 'immediately' | 'redeploy' | null
}

async function ownerMailDomains(ownerId: string): Promise<string[]> {
  const rows = await db.emailService.findMany({
    where: { userId: ownerId, status: 'active' },
    select: { domain: true },
    orderBy: { domain: 'asc' },
  })
  return rows.map((r) => r.domain.toLowerCase())
}

export async function getSiteMailStatus(projectId: string): Promise<SiteMailStatus> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { userId: true, deploymentMethod: true, siteMail: true },
  })
  if (!project) throw new SiteMailError('Project not found', 404)
  const m = project.siteMail
  const method = project.deploymentMethod || null
  return {
    supported: isSiteMailMethod(method),
    method,
    enabled: !!m?.enabled,
    provisioned: !!m?.mailboxCreated,
    address: m?.address ?? null,
    fromAddress: m?.fromAddress ?? null,
    fromName: m?.fromName ?? null,
    smtpHost: siteMailSmtpHost(),
    smtpPort: siteMailSmtpPort(),
    rateLimitPerHour: m?.rateLimitPerHour ?? null,
    lastError: m?.lastError ?? null,
    lastTest: m?.lastTestAt
      ? { at: m.lastTestAt.toISOString(), ok: !!m.lastTestOk, message: m.lastTestMessage ?? null }
      : null,
    fromDomains: await ownerMailDomains(project.userId),
    appliesOn: method === 'wordpress' ? 'immediately' : method === 'php' ? 'redeploy' : null,
  }
}

/** Pick an address no other site holds. */
async function freeAddress(slug: string): Promise<string> {
  const domain = siteMailDomain()
  if (!domain) throw new SiteMailError('No sending domain is configured (SITE_MAIL_DOMAIN / NO_REPLY_EMAIL).', 503)
  for (let i = 0; i < 5; i++) {
    const local = siteMailLocalPart(slug, i === 0 ? undefined : crypto.randomBytes(3).toString('hex'))
    const address = `${local}@${domain}`
    const taken = await db.siteMail.findUnique({ where: { address }, select: { id: true } })
    if (!taken) return address
  }
  throw new SiteMailError('Could not choose a sending address for this site.', 500)
}

/**
 * Create the Mailcow mailbox for a row whose mailbox does not exist yet.
 * An existing mailbox under our site-* name is an orphan of an earlier
 * attempt (the address is unique in our table): take it over with our password.
 */
async function provisionMailbox(row: { id: string; address: string; passwordEnc: string; rateLimitPerHour: number; fromAddress: string | null }, displayName: string): Promise<boolean> {
  const [localPart, domain] = row.address.split('@')
  const password = decrypt(row.passwordEnc)
  let res = await createMailbox({ localPart, domain, password, name: displayName, quota: siteMailQuotaMB() })
  if (!res.success && /object_exists|is_alias_or_mailbox/i.test(res.error || '')) {
    res = await updateMailbox({ address: row.address, password, active: true })
  }
  if (!res.success) {
    await db.siteMail.update({ where: { id: row.id }, data: { lastError: mailcowErrorText(res.error) } })
    return false
  }
  const problems: string[] = []
  const rl = await setMailboxRateLimit(row.address, row.rateLimitPerHour, 'h')
  if (!rl.success) problems.push(`rate limit not applied: ${mailcowErrorText(rl.error)}`)
  if (row.fromAddress) {
    const acl = await setMailboxSenderAcl(row.address, [row.fromAddress])
    if (!acl.success) problems.push(`From address not allowed yet: ${mailcowErrorText(acl.error)}`)
  }
  await db.siteMail.update({
    where: { id: row.id },
    data: { mailboxCreated: true, lastError: problems.length ? problems.join('; ') : null },
  })
  return true
}

/**
 * Make sure a WordPress/PHP site has a working sending identity. Called by the
 * deployer; idempotent. Never throws — a mail problem must not fail a deploy —
 * and returns the runtime config, or null when mail is off or unavailable.
 */
export async function ensureSiteMail(projectId: string, log: (m: string) => void = () => {}): Promise<SiteMailRuntime | null> {
  try {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { slug: true, name: true, deploymentMethod: true, siteMail: true },
    })
    if (!project || !isSiteMailMethod(project.deploymentMethod)) return null
    let row = project.siteMail
    if (row && !row.enabled) {
      log('Outgoing mail is switched off for this site.')
      return null
    }
    if (mailcowDemoForbidden()) {
      log(`Outgoing mail not set up: ${MAIL_SERVER_NOT_CONFIGURED}.`)
      return null
    }
    if (!row) {
      const address = await freeAddress(project.slug)
      try {
        row = await db.siteMail.create({
          data: {
            projectId,
            address,
            passwordEnc: encrypt(newPassword()),
            rateLimitPerHour: siteMailRateLimitPerHour(),
          },
        })
      } catch {
        // A concurrent deploy/API call created it first.
        row = await db.siteMail.findUnique({ where: { projectId } })
        if (!row) throw new Error('could not create the site mail record')
      }
    }
    if (!row.mailboxCreated) {
      const ok = await provisionMailbox(row, `Website ${project.name}`.slice(0, 100))
      if (!ok) {
        const fresh = await db.siteMail.findUnique({ where: { id: row.id }, select: { lastError: true } })
        log(`Outgoing mail not set up yet: ${fresh?.lastError || 'mail server error'}. The next deploy retries.`)
        return null
      }
      log(`Outgoing mail: sending as ${row.fromAddress || row.address} (${row.rateLimitPerHour}/hour).`)
    }
    return getSiteMailRuntime(projectId)
  } catch (err) {
    log(`Outgoing mail not set up: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Runtime config (with the plaintext password) for an enabled, provisioned site. */
export async function getSiteMailRuntime(projectId: string): Promise<SiteMailRuntime | null> {
  const row = await db.siteMail.findUnique({ where: { projectId } })
  if (!row || !row.enabled || !row.mailboxCreated) return null
  let password: string
  try {
    password = decrypt(row.passwordEnc)
  } catch {
    return null
  }
  return {
    host: siteMailSmtpHost(),
    port: siteMailSmtpPort(),
    user: row.address,
    password,
    from: row.fromAddress || row.address,
    fromName: row.fromName,
  }
}

async function projectFor(projectId: string) {
  const p = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, slug: true, name: true, deploymentMethod: true },
  })
  if (!p) throw new SiteMailError('Project not found', 404)
  if (!isSiteMailMethod(p.deploymentMethod)) {
    throw new SiteMailError('Outgoing mail is available for WordPress and PHP sites only.', 422)
  }
  if (mailcowDemoForbidden()) throw new SiteMailError(MAIL_SERVER_NOT_CONFIGURED, 503)
  return p
}

/**
 * Turn sending on (creating the mailbox if needed) and optionally change the
 * From. `fromAddress` must be on a mail domain the PROJECT OWNER hosts with
 * us (active EmailService); null resets to the site mailbox.
 */
export async function enableSiteMail(
  projectId: string,
  input: { fromAddress?: string | null; fromName?: string | null }
): Promise<void> {
  const p = await projectFor(projectId)
  if (input.fromAddress) {
    const domain = input.fromAddress.split('@')[1]
    const domains = await ownerMailDomains(p.userId)
    if (!domains.includes(domain)) {
      throw new SiteMailError('The From address must be on an email domain you host with us.', 422)
    }
  }
  let row = await db.siteMail.findUnique({ where: { projectId } })
  if (!row) {
    await ensureSiteMail(projectId)
    row = await db.siteMail.findUnique({ where: { projectId } })
    if (!row) throw new SiteMailError('Could not set up the sending mailbox.', 502)
  }
  const data: { enabled: boolean; fromAddress?: string | null; fromName?: string | null } = { enabled: true }
  if (input.fromAddress !== undefined) data.fromAddress = input.fromAddress
  if (input.fromName !== undefined) data.fromName = input.fromName
  row = await db.siteMail.update({ where: { id: row.id }, data })

  if (!row.mailboxCreated) {
    const ok = await provisionMailbox(row, `Website ${p.name}`.slice(0, 100))
    if (!ok) throw new SiteMailError(`The mail server refused the mailbox: ${(await db.siteMail.findUnique({ where: { id: row.id } }))?.lastError || 'unknown error'}`, 502)
    return
  }
  const active = await updateMailbox({ address: row.address, active: true })
  if (!active.success) throw new SiteMailError(`Could not activate the mailbox: ${mailcowErrorText(active.error)}`, 502)
  if (input.fromAddress !== undefined) {
    const acl = await setMailboxSenderAcl(row.address, row.fromAddress ? [row.fromAddress] : [])
    if (!acl.success) throw new SiteMailError(`Could not allow that From address: ${mailcowErrorText(acl.error)}`, 502)
  }
  await db.siteMail.update({ where: { id: row.id }, data: { lastError: null } })
}

/** Stop sending: deactivate the mailbox (kept, so enabling again is instant). */
export async function disableSiteMail(projectId: string): Promise<void> {
  await projectFor(projectId)
  const row = await db.siteMail.findUnique({ where: { projectId } })
  if (!row) {
    // Record the choice so the next deploy does not provision one.
    const address = await freeAddress((await db.project.findUnique({ where: { id: projectId }, select: { slug: true } }))!.slug)
    await db.siteMail.create({
      data: { projectId, address, passwordEnc: encrypt(newPassword()), enabled: false, rateLimitPerHour: siteMailRateLimitPerHour() },
    })
    return
  }
  if (row.mailboxCreated) {
    const res = await updateMailbox({ address: row.address, active: false })
    if (!res.success) throw new SiteMailError(`Could not deactivate the mailbox: ${mailcowErrorText(res.error)}`, 502)
  }
  await db.siteMail.update({ where: { id: row.id }, data: { enabled: false } })
}

/** New random password in Mailcow first, then in the database. */
export async function rotateSiteMailPassword(projectId: string): Promise<void> {
  await projectFor(projectId)
  const row = await db.siteMail.findUnique({ where: { projectId } })
  if (!row || !row.mailboxCreated) throw new SiteMailError('Outgoing mail is not set up for this site yet.', 409)
  const password = newPassword()
  const res = await updateMailbox({ address: row.address, password })
  if (!res.success) throw new SiteMailError(`The mail server refused the new password: ${mailcowErrorText(res.error)}`, 502)
  await db.siteMail.update({ where: { id: row.id }, data: { passwordEnc: encrypt(password), lastError: null } })
}

/** PHP snippet a test runs inside the site container. The recipient comes from the environment. */
export function containerTestScript(method: 'wordpress' | 'php'): string {
  const subject = 'Test email from your website'
  const body = 'This test was sent by your website through the hosting mail server. If you can read it, your site can send email.'
  if (method === 'wordpress') {
    return [
      "$_SERVER['HTTP_HOST'] = $_SERVER['HTTP_HOST'] ?? 'localhost';",
      "define('WP_USE_THEMES', false);",
      "require '/var/www/html/wp-load.php';",
      "$err = '';",
      "add_action('wp_mail_failed', function ($e) use (&$err) { $err = $e->get_error_message(); });",
      `$ok = wp_mail(getenv('APSAMO_TEST_TO'), '${subject}', '${body}');`,
      "echo $ok ? 'APSAMO_MAIL_OK' : ('APSAMO_MAIL_FAIL ' . $err);",
    ].join(' ')
  }
  return `$ok = mail(getenv('APSAMO_TEST_TO'), '${subject}', '${body}'); echo $ok ? 'APSAMO_MAIL_OK' : 'APSAMO_MAIL_FAIL mail() returned false';`
}

/**
 * Send a test email to the project OWNER's account address.
 *
 * Where the site is deployed on a real server, the email is sent from INSIDE
 * the site container (the path real mail takes). Otherwise the panel sends it
 * over SMTP with the site's credentials, which proves the mailbox and the
 * mail server but not the container's network path; `via` says which.
 */
export async function sendSiteMailTest(
  projectId: string,
  runInContainer: (method: 'wordpress' | 'php', script: string, to: string) => Promise<{ ok: boolean; message: string } | null>
): Promise<{ ok: boolean; message: string; to: string; via: 'container' | 'panel' | 'simulated' }> {
  const p = await projectFor(projectId)
  const row = await db.siteMail.findUnique({ where: { projectId } })
  if (!row || !row.enabled || !row.mailboxCreated) {
    throw new SiteMailError('Turn outgoing mail on before sending a test.', 409)
  }
  if (row.lastTestAt && Date.now() - row.lastTestAt.getTime() < TEST_COOLDOWN_MS) {
    throw new SiteMailError('Please wait a minute between test emails.', 429)
  }
  const owner = await db.user.findUnique({ where: { id: p.userId }, select: { email: true } })
  if (!owner?.email) throw new SiteMailError('The site owner has no email address.', 409)
  const to = owner.email
  // Claim the cooldown slot before sending so parallel requests cannot both send.
  await db.siteMail.update({ where: { id: row.id }, data: { lastTestAt: new Date() } })

  let result: { ok: boolean; message: string; via: 'container' | 'panel' | 'simulated' }
  if (!isMailcowConfigured()) {
    result = { ok: true, message: 'Simulated: no mail server is configured in this environment.', via: 'simulated' }
  } else {
    const inContainer = await runInContainer(p.deploymentMethod as 'wordpress' | 'php', containerTestScript(p.deploymentMethod as 'wordpress' | 'php'), to).catch(
      (e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) })
    )
    if (inContainer) {
      result = { ...inContainer, via: 'container' }
    } else {
      const rt = await getSiteMailRuntime(projectId)
      if (!rt) throw new SiteMailError('Outgoing mail is not set up for this site yet.', 409)
      try {
        const t = nodemailer.createTransport({
          host: rt.host,
          port: rt.port,
          secure: rt.port === 465,
          requireTLS: rt.port !== 465,
          auth: { user: rt.user, pass: rt.password },
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 30_000,
        })
        await t.sendMail({
          from: rt.fromName ? { name: rt.fromName, address: rt.from } : rt.from,
          sender: rt.user,
          envelope: { from: rt.user, to },
          to,
          subject: 'Test email from your website',
          text: 'This test was sent with your website\'s mail settings through the hosting mail server.',
        })
        result = { ok: true, message: 'Sent.', via: 'panel' }
      } catch (err) {
        // nodemailer errors carry the SMTP response, never the password.
        result = { ok: false, message: (err instanceof Error ? err.message : String(err)).slice(0, 300), via: 'panel' }
      }
    }
  }
  await db.siteMail.update({
    where: { id: row.id },
    data: { lastTestOk: result.ok, lastTestMessage: result.message.slice(0, 300) },
  })
  return { ...result, to }
}

/** Project deletion: remove the mailbox. Returns a warning or null. Never throws. */
export async function removeSiteMail(projectId: string): Promise<string | null> {
  try {
    const row = await db.siteMail.findUnique({ where: { projectId } })
    if (!row) return null
    if (row.mailboxCreated) {
      const res = await deleteMailbox(row.address)
      if (!res.success && !/access_denied/i.test(res.error || '')) {
        return `Sending mailbox ${row.address} could not be deleted: ${mailcowErrorText(res.error)}`
      }
    }
    await db.siteMail.delete({ where: { id: row.id } }).catch(() => {})
    return null
  } catch (err) {
    return `Sending mailbox cleanup failed: ${err instanceof Error ? err.message : String(err)}`
  }
}
