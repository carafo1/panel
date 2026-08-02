/**
 * Webmail single sign-on
 * ======================
 *
 * Signs a customer into webmail from the panel without them typing a password.
 *
 * Why it has to work this way — all measured against the live mail server:
 *
 *  - SOGo's own login form can never accept a real password. Mailcow writes a
 *    random, unusable hash into SOGo's auth view on purpose ("generate random
 *    password for sogo to deny direct login", its own source). So /SOGo/ is a
 *    dead end and always was.
 *  - App passwords are rejected by mailcow's UI login (tested: real password →
 *    302 + MAILCOWUI logged; app password → 200, refused). So a scoped
 *    throwaway credential cannot drive this.
 *  - Mailcow's UI login accepts a cold cross-origin POST with no cookies and no
 *    CSRF token (tested: 302 + MAILCOWUI logged). That is what makes an
 *    auto-submitted form from the panel viable.
 *
 * Which leaves exactly one workable credential: the real mailbox password,
 * encrypted at rest and replayed by the browser into mailcow's login form.
 *
 * The password is written into a self-submitting form rather than sent through
 * a URL, so it never lands in browser history, a Referer header, or a server
 * access log. The page is generated per click, is `no-store`, and is only
 * reachable by the authenticated owner of that mailbox.
 */
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'
import { mailServerHost } from '@/lib/email-hosting'

/**
 * Remember (or update) the password the panel just set for a mailbox.
 *
 * Best-effort by design: single sign-on is a convenience, so a storage failure
 * must never break creating a mailbox or changing its password.
 */
export async function rememberMailboxPassword(opts: {
  serviceId: string
  address: string
  password: string
}): Promise<void> {
  const address = opts.address.toLowerCase().trim()
  try {
    const passwordEnc = encrypt(opts.password)
    await db.emailMailboxSecret.upsert({
      where: { address },
      create: { serviceId: opts.serviceId, address, passwordEnc },
      update: { serviceId: opts.serviceId, passwordEnc, lastVerifiedAt: null },
    })
  } catch (err) {
    console.error('[webmail-sso] could not store credential for', address, err)
  }
}

/** Drop a stored credential — used when the mailbox is deleted. */
export async function forgetMailboxPassword(address: string): Promise<void> {
  await db.emailMailboxSecret
    .deleteMany({ where: { address: address.toLowerCase().trim() } })
    .catch(() => {})
}

/**
 * The plaintext password for a mailbox, or null when the panel does not hold
 * one (created outside the panel, or changed directly in mailcow).
 */
export async function getMailboxPassword(
  address: string
): Promise<string | null> {
  const row = await db.emailMailboxSecret
    .findUnique({ where: { address: address.toLowerCase().trim() } })
    .catch(() => null)
  if (!row) return null
  try {
    const plain = decrypt(row.passwordEnc)
    return plain || null
  } catch (err) {
    // A rotated ENCRYPTION_KEY makes old ciphertext undecryptable. Treat it as
    // "no credential" so the customer falls back to normal login.
    console.error('[webmail-sso] could not decrypt credential for', address, err)
    return null
  }
}

export async function hasStoredPassword(address: string): Promise<boolean> {
  const row = await db.emailMailboxSecret
    .findUnique({
      where: { address: address.toLowerCase().trim() },
      select: { id: true },
    })
    .catch(() => null)
  return Boolean(row)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * An HTML page that posts the credential straight into mailcow's login form
 * and lands the customer in webmail.
 *
 * The form targets the mail host's front page because that is what issues the
 * session; mailcow then redirects onward. `referrerPolicy=no-referrer` keeps
 * the panel URL out of the mail server's logs, and the form is submitted on
 * load so nothing is left on screen if scripting is slow.
 */
export function buildSsoPage(opts: {
  address: string
  password: string
}): string {
  const host = mailServerHost()
  const action = `https://${host}/`
  const user = escapeHtml(opts.address)
  const pass = escapeHtml(opts.password)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Signing you in…</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;
       align-items:center;justify-content:center;height:100vh;margin:0;
       background:#0b0a1f;color:#e8e8f0}
  .box{text-align:center}
  .spin{width:34px;height:34px;margin:0 auto 14px;border:3px solid #3a3760;
        border-top-color:#8888ff;border-radius:50%;animation:r .8s linear infinite}
  @keyframes r{to{transform:rotate(360deg)}}
  .sub{opacity:.65;font-size:13px;margin-top:6px}
  button{margin-top:16px;padding:8px 16px;border-radius:6px;border:0;
         background:#706FD3;color:#fff;font-size:14px;cursor:pointer}
</style>
</head>
<body>
  <div class="box">
    <div class="spin"></div>
    <div>Signing you in to webmail…</div>
    <div class="sub">${user}</div>
    <form id="f" method="POST" action="${action}">
      <input type="hidden" name="login_user" value="${user}">
      <input type="hidden" name="pass_user" value="${pass}">
      <noscript><button type="submit">Continue to webmail</button></noscript>
    </form>
  </div>
<script>document.getElementById('f').submit();</script>
</body>
</html>`
}
