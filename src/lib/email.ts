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

const FROM_NAME = process.env.SMTP_FROM_NAME || 'DeployHub'
const FROM_EMAIL =
  process.env.SMTP_FROM_EMAIL || 'no-reply@deployhub.local'

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
 * Send an email. Returns success in demo mode (no real email sent).
 */
export async function sendEmail(
  opts: SendEmailOptions
): Promise<SendEmailResult> {
  const t = getTransporter()
  if (!t) {
    // Demo mode - log to console
     
    console.log(
      `\n========== [DEMO EMAIL] ==========\n` +
        `To: ${opts.to}\n` +
        `Subject: ${opts.subject}\n` +
        `----- HTML -----\n${opts.html}\n` +
        `----------------\n`
    )
    return {
      success: true,
      messageId: `demo-${Date.now()}@deployhub.local`,
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
    subject: 'Welcome to DeployHub - please verify your email',
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: auto; padding: 32px;">
        <h1 style="color: #10b981;">Welcome to DeployHub, ${name}!</h1>
        <p>We're excited to have you on board. Before you can start deploying, please verify your email address:</p>
        <p style="text-align: center; margin: 32px 0;">
          <a href="${verificationUrl}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
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
    text: `Welcome to DeployHub, ${name}!\n\nPlease verify your email by visiting: ${verificationUrl}`,
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
    subject: 'Reset your DeployHub password',
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: auto; padding: 32px;">
        <h1 style="color: #10b981;">Password reset request</h1>
        <p>We received a request to reset your DeployHub password. Click the button below to choose a new password:</p>
        <p style="text-align: center; margin: 32px 0;">
          <a href="${resetUrl}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
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
    text: `Reset your DeployHub password by visiting: ${resetUrl}\n\nThis link expires in 1 hour.`,
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
    subject: `You've been invited to join "${teamName}" on DeployHub`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: auto; padding: 32px;">
        <h1 style="color: #10b981;">Team invitation</h1>
        <p>You've been invited to collaborate on the team <strong>${teamName}</strong> on DeployHub.</p>
        <p style="text-align: center; margin: 32px 0;">
          <a href="${inviteUrl}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Accept Invitation
          </a>
        </p>
        <p style="color: #6b7280; font-size: 14px;">
          Or copy this link into your browser:<br/>
          <a href="${inviteUrl}">${inviteUrl}</a>
        </p>
      </div>
    `,
    text: `You've been invited to join "${teamName}" on DeployHub.\n\nAccept: ${inviteUrl}`,
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
  const color = isSuccess ? '#10b981' : '#ef4444'
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
