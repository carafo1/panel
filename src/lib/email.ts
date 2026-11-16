/**
 * Email service with graceful fallback to console logging.
 *
 * Used by:
 *  - #2 Real Email Delivery
 *
 * If SMTP env vars (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) are set,
 * we send real email via nodemailer. Otherwise we log to console and return
 * success (demo mode) so the rest of the application keeps working.
 */
import nodemailer from 'nodemailer'
import { FROM_NAME, FROM_EMAIL } from '@/lib/brand-config'
import { isProduction } from '@/lib/demo-mode'

interface SendEmailOptions {
  to: string
  subject: string
  html: string
  text?: string
}

interface SendEmailResult {
  success: boolean
  messageId?: string
  demo?: boolean
}

// Brand-configured From name/email (env-var overridable; APSAMO by default).
// FROM_NAME / FROM_EMAIL are imported from brand-config so existing deployments
// can keep their DeployHub-branded sender identity via env vars.

let transporter: nodemailer.Transporter | null = null
let transporterWarningLogged = false

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    if (!transporterWarningLogged) {
       
      console.warn(
        '\x1b[33m[email] SMTP env vars not configured - running in demo mode. ' +
          'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS to send real email.\x1b[0m'
      )
      transporterWarningLogged = true
    }
    return null
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  })
  return transporter
}

/**
 * Send mail over HTTPS (port 443) via a provider's REST API. This is the only
 * path that works on hosts where outbound SMTP (25/465/587) is blocked — which
 * is the case on the Apsamo production VPS. Configure with:
 *   EMAIL_PROVIDER = resend | brevo | sendgrid
 *   EMAIL_API_KEY  = <the provider's API key>
 * Returns a result, or `null` for an unknown provider so the caller can fall
 * back to SMTP / demo mode.
 */
async function sendViaApi(
  provider: string,
  apiKey: string,
  opts: SendEmailOptions
): Promise<SendEmailResult | null> {
  const text = opts.text ?? opts.html.replace(/<[^>]*>/g, '')
  try {
    if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
          to: [opts.to],
          subject: opts.subject,
          html: opts.html,
          text,
        }),
      })
      if (res.ok) {
        const d = (await res.json().catch(() => ({}))) as { id?: string }
        return { success: true, messageId: d.id }
      }
      console.error('[email] Resend API error', res.status, (await res.text().catch(() => '')).slice(0, 300))
      return { success: false }
    }
    if (provider === 'brevo' || provider === 'sendinblue') {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: FROM_EMAIL, name: FROM_NAME },
          to: [{ email: opts.to }],
          subject: opts.subject,
          htmlContent: opts.html,
          textContent: text,
        }),
      })
      if (res.ok) {
        const d = (await res.json().catch(() => ({}))) as { messageId?: string }
        return { success: true, messageId: d.messageId }
      }
      console.error('[email] Brevo API error', res.status, (await res.text().catch(() => '')).slice(0, 300))
      return { success: false }
    }
    if (provider === 'sendgrid') {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: opts.to }] }],
          from: { email: FROM_EMAIL, name: FROM_NAME },
          subject: opts.subject,
          content: [
            { type: 'text/plain', value: text || ' ' },
            { type: 'text/html', value: opts.html },
          ],
        }),
      })
      if (res.ok) {
        return { success: true, messageId: res.headers.get('x-message-id') || undefined }
      }
      console.error('[email] SendGrid API error', res.status, (await res.text().catch(() => '')).slice(0, 300))
      return { success: false }
    }
  } catch (err) {
    console.error(`[email] ${provider} API request failed:`, err)
    return { success: false }
  }
  return null // unknown provider → let the caller fall back
}

/**
 * Send an email. Prefers an HTTP-API provider (works where SMTP is blocked),
 * then SMTP, then demo-mode console logging.
 */
export async function sendEmail(
  opts: SendEmailOptions
): Promise<SendEmailResult> {
  // 1) HTTP-API provider (Resend/Brevo/SendGrid) over 443 — the only path that
  //    works on this VPS, where outbound SMTP ports are blocked.
  const provider = (process.env.EMAIL_PROVIDER || '').toLowerCase().trim()
  const apiKey = process.env.EMAIL_API_KEY || process.env.RESEND_API_KEY || ''
  if (provider && apiKey) {
    const apiResult = await sendViaApi(provider, apiKey, opts)
    if (apiResult) return apiResult
  }

  // 2) SMTP (nodemailer) — kept for hosts that allow outbound SMTP.
  const t = getTransporter()
  if (!t) {
    // SECURITY: never print message bodies in production. They carry password
    // reset links, verification links and invitations — anything in the log
    // could take over an account. And don't report a message as sent when it
    // wasn't: callers (and customers) would believe it arrived.
    if (isProduction()) {
      console.error(
        `[email] No email provider configured — "${opts.subject}" to ${opts.to} was NOT sent. ` +
          'Set EMAIL_PROVIDER + EMAIL_API_KEY, or SMTP_HOST/PORT/USER/PASS.'
      )
      return { success: false }
    }
    // Development only: show the message so links can be followed locally.
    console.log(
      `\n========== [DEMO EMAIL] ==========\n` +
        `To: ${opts.to}\n` +
        `Subject: ${opts.subject}\n` +
        `----- HTML -----\n${opts.html}\n` +
        `----------------\n`
    )
    return {
      success: true,
      messageId: `demo-${Date.now()}@${FROM_EMAIL.split('@')[1] || 'apsamo.com'}`,
      demo: true,
    }
  }

  try {
    const info = await t.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text ?? opts.html.replace(/<[^>]*>/g, ''),
    })
    return { success: true, messageId: info.messageId }
  } catch (error) {
     
    console.error('[email] Failed to send email:', error)
    return { success: false }
  }
}

/**
 * Send a welcome + email-verification email.
 */
export async function sendWelcomeEmail(
  email: string,
  name: string,
  verificationUrl: string
): Promise<SendEmailResult> {
  return sendEmail({
    to: email,
    subject: 'Welcome to Apsamo Technology - please verify your email',
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: auto; padding: 32px;">
        <h1 style="color: #706fd3;">Welcome to Apsamo Technology, ${name}!</h1>
        <p>We're excited to have you on board. Before you can start deploying, please verify your email address:</p>
        <p style="text-align: center; margin: 32px 0;">
          <a href="${verificationUrl}" style="background: #706fd3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Verify Email
          </a>
        </p>
        <p style="color: #6b7280; font-size: 14px;">
          Or copy this link into your browser:<br/>
          <a href="${verificationUrl}">${verificationUrl}</a>
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;"/>
        <p style="color: #9ca3af; font-size: 12px;">
          If you did not create an account, you can safely ignore this email.
        </p>
      </div>
    `,
    text: `Welcome to Apsamo Technology, ${name}!\n\nPlease verify your email by visiting: ${verificationUrl}`,
  })
}

/**
 * Send a password-reset email.
 */
export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string
): Promise<SendEmailResult> {
  return sendEmail({
    to: email,
    subject: 'Reset your Apsamo Technology password',
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: auto; padding: 32px;">
        <h1 style="color: #706fd3;">Password reset request</h1>
        <p>We received a request to reset your Apsamo Technology password. Click the button below to choose a new password:</p>
        <p style="text-align: center; margin: 32px 0;">
          <a href="${resetUrl}" style="background: #706fd3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Reset Password
          </a>
        </p>
        <p style="color: #6b7280; font-size: 14px;">
          Or copy this link into your browser:<br/>
          <a href="${resetUrl}">${resetUrl}</a>
        </p>
        <p style="color: #ef4444; font-size: 13px;">
          This link will expire in 1 hour. If you did not request a reset, please ignore this email.
        </p>
      </div>
    `,
    text: `Reset your Apsamo Technology password by visiting: ${resetUrl}\n\nThis link expires in 1 hour.`,
  })
}

/**
 * Send a team-invitation email.
 */
export async function sendTeamInvitationEmail(
  email: string,
  teamName: string,
  inviteUrl: string
): Promise<SendEmailResult> {
  return sendEmail({
    to: email,
    subject: `You've been invited to join "${teamName}" on Apsamo Technology`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: auto; padding: 32px;">
        <h1 style="color: #706fd3;">Team invitation</h1>
        <p>You've been invited to collaborate on the team <strong>${teamName}</strong> on Apsamo Technology.</p>
        <p style="text-align: center; margin: 32px 0;">
          <a href="${inviteUrl}" style="background: #706fd3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Accept Invitation
          </a>
        </p>
        <p style="color: #6b7280; font-size: 14px;">
          Or copy this link into your browser:<br/>
          <a href="${inviteUrl}">${inviteUrl}</a>
        </p>
      </div>
    `,
    text: `You've been invited to join "${teamName}" on Apsamo Technology.\n\nAccept: ${inviteUrl}`,
  })
}

/**
 * Send a deployment-status email.
 */
export async function sendDeploymentEmail(
  email: string,
  projectName: string,
  status: string,
  url?: string
): Promise<SendEmailResult> {
  const isSuccess = status === 'live' || status === 'success'
  const color = isSuccess ? '#706fd3' : '#ef4444'
  const icon = isSuccess ? '✅' : '⚠️'

  return sendEmail({
    to: email,
    subject: `${icon} Deployment ${status}: ${projectName}`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: auto; padding: 32px;">
        <h1 style="color: ${color};">${icon} Deployment ${status}</h1>
        <p>Your project <strong>${projectName}</strong> deployment is now <strong>${status}</strong>.</p>
        ${
          url
            ? `<p>Visit your deployment: <a href="${url}">${url}</a></p>`
            : ''
        }
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;"/>
        <p style="color: #9ca3af; font-size: 12px;">
          You're receiving this email because deployment notifications are enabled for your project.
        </p>
      </div>
    `,
    text: `${icon} Deployment ${status}\n\nProject: ${projectName}\nStatus: ${status}${
      url ? `\nURL: ${url}` : ''
    }`,
  })
}
