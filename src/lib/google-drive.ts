/**
 * Google Drive as a customer-owned backup destination.
 *
 * A backup that lives only on the machine being backed up does not protect
 * anyone from the failure that matters. This lets each customer connect their
 * own Drive so a copy leaves our infrastructure entirely — their account,
 * their quota, their copy.
 *
 * SCOPE — `drive.file`, deliberately, not `drive`:
 *   - It grants access ONLY to files this app creates. A customer is not
 *     handing over their photos and documents to a hosting panel, and would be
 *     right to refuse if they were.
 *   - It is a NON-SENSITIVE scope, so it does not trigger Google's OAuth
 *     verification review. `drive` or `drive.readonly` would, and that is a
 *     multi-week process with an annual security assessment attached.
 *   - The tradeoff: we cannot see the folder if the customer moves or deletes
 *     it. Handled by storing folderId and recreating when it goes missing.
 *
 * TOKENS — the refresh token is the whole credential; it mints access tokens
 * indefinitely. Encrypted at rest, never returned by any endpoint, and only
 * ever decrypted in this module.
 */
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

/** Only what this app creates. See the scope note above. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

export interface DriveConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/**
 * Is Drive integration configured at all?
 *
 * Returns null rather than throwing so callers can report "not configured"
 * honestly instead of showing a Connect button that cannot work.
 */
export function driveConfig(): DriveConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  const base = (process.env.APP_URL || 'https://panel.apsamo.com').replace(/\/+$/, '')
  return {
    clientId,
    clientSecret,
    redirectUri: `${base}/api/backups/google/callback`,
  }
}

/**
 * The URL to send the customer to.
 *
 * `access_type=offline` + `prompt=consent` because we need a refresh token,
 * and Google only issues one on the first consent unless consent is forced.
 * Without this, reconnecting an account returns no refresh token and the
 * integration silently stops working a hour later.
 */
export function authorizeUrl(state: string): string | null {
  const cfg = driveConfig()
  if (!cfg) return null
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_URL}?${p.toString()}`
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  error?: string
  error_description?: string
}

/** Swap the one-time code for tokens. */
export async function exchangeCode(code: string): Promise<{
  ok: boolean
  error?: string
  refreshToken?: string
  accessToken?: string
  expiresAt?: Date
  email?: string
}> {
  const cfg = driveConfig()
  if (!cfg) return { ok: false, error: 'Google Drive integration is not configured.' }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const data = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok || !data.access_token) {
    return { ok: false, error: data.error_description || data.error || 'Token exchange failed.' }
  }
  if (!data.refresh_token) {
    // Without it we can only work for one hour and then break. Better to
    // refuse the connection than to accept one that expires quietly.
    return {
      ok: false,
      error:
        'Google did not return a refresh token. Remove this app from your ' +
        'Google account permissions and connect again.',
    }
  }

  let email: string | undefined
  try {
    const who = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    })
    if (who.ok) email = ((await who.json()) as { email?: string }).email
  } catch {
    // Display only — a missing address is not a reason to fail the connection.
  }

  return {
    ok: true,
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000),
    email,
  }
}

/**
 * A usable access token for this destination, refreshing if needed.
 *
 * Refreshes 2 minutes early: a token that expires mid-upload fails the upload,
 * and a large backup can spend a while in flight.
 */
async function accessTokenFor(destId: string): Promise<string | null> {
  const cfg = driveConfig()
  if (!cfg) return null

  const dest = await db.backupDestination.findUnique({ where: { id: destId } })
  if (!dest) return null

  if (
    dest.accessTokenEnc &&
    dest.accessExpiresAt &&
    dest.accessExpiresAt.getTime() - Date.now() > 120_000
  ) {
    try {
      return decrypt(dest.accessTokenEnc)
    } catch {
      // Fall through and refresh — a corrupt cache is not fatal.
    }
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: decrypt(dest.refreshTokenEnc),
      grant_type: 'refresh_token',
    }),
  })
  const data = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok || !data.access_token) {
    // A revoked or expired refresh token lands here. Record it so the customer
    // is told, rather than discovering it when they need a restore.
    await db.backupDestination
      .update({
        where: { id: destId },
        data: {
          lastStatus: 'failed',
          lastError:
            data.error === 'invalid_grant'
              ? 'Google access was revoked or expired. Reconnect your Drive.'
              : data.error_description || data.error || 'Could not refresh Google access.',
        },
      })
      .catch(() => {})
    return null
  }

  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000)
  await db.backupDestination
    .update({
      where: { id: destId },
      data: { accessTokenEnc: encrypt(data.access_token), accessExpiresAt: expiresAt },
    })
    .catch(() => {})
  return data.access_token
}

/** Find or create the folder we own, returning its id. */
async function ensureFolder(destId: string, token: string): Promise<string | null> {
  const dest = await db.backupDestination.findUnique({ where: { id: destId } })
  if (!dest) return null

  if (dest.folderId) {
    // Confirm it still exists — with drive.file we cannot search for it, and a
    // customer who deleted it would otherwise get uploads into nothing.
    const check = await fetch(`${FILES_URL}/${dest.folderId}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (check.ok) {
      const f = (await check.json()) as { trashed?: boolean }
      if (!f.trashed) return dest.folderId
    }
  }

  const res = await fetch(`${FILES_URL}?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: dest.folderName || 'Apsamo Backups',
      mimeType: 'application/vnd.google-apps.folder',
    }),
  })
  if (!res.ok) return null
  const created = (await res.json()) as { id: string }
  await db.backupDestination
    .update({ where: { id: destId }, data: { folderId: created.id } })
    .catch(() => {})
  return created.id
}

export interface UploadResult {
  ok: boolean
  error?: string
  fileId?: string
  bytes?: number
}

/**
 * Upload one backup archive.
 *
 * Multipart rather than resumable: these archives are tens of megabytes, and
 * resumable adds a session round-trip per file for a benefit that only shows
 * up on unreliable multi-gigabyte transfers. Revisit if backups grow.
 */
export async function uploadBackup(
  destId: string,
  filename: string,
  content: Buffer
): Promise<UploadResult> {
  const token = await accessTokenFor(destId)
  if (!token) return { ok: false, error: 'Could not obtain Google access. Reconnect your Drive.' }

  const folderId = await ensureFolder(destId, token)
  if (!folderId) return { ok: false, error: 'Could not create the backup folder in Drive.' }

  const boundary = `apsamo-${Date.now().toString(36)}`
  const meta = JSON.stringify({ name: filename, parents: [folderId] })
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])

  const res = await fetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,size`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: new Uint8Array(body),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const error =
      res.status === 403 && /quota/i.test(detail)
        ? 'Your Google Drive is full — the backup could not be uploaded.'
        : `Drive upload failed (HTTP ${res.status}).`
    await db.backupDestination
      .update({ where: { id: destId }, data: { lastStatus: 'failed', lastError: error } })
      .catch(() => {})
    return { ok: false, error }
  }

  const file = (await res.json()) as { id: string; size?: string }
  await db.backupDestination
    .update({
      where: { id: destId },
      data: {
        lastStatus: 'ok',
        lastError: null,
        lastSyncAt: new Date(),
        bytesStored: { increment: BigInt(content.length) },
      },
    })
    .catch(() => {})

  return { ok: true, fileId: file.id, bytes: content.length }
}

/** Revoke at Google as well as locally — leaving a live grant behind is rude. */
export async function disconnect(destId: string): Promise<void> {
  const dest = await db.backupDestination.findUnique({ where: { id: destId } })
  if (!dest) return
  try {
    const token = decrypt(dest.refreshTokenEnc)
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST',
    })
  } catch {
    // Revocation is best effort; the row still goes.
  }
  await db.backupDestination.delete({ where: { id: destId } }).catch(() => {})
}


export interface DriveFile {
  id: string
  name: string
  bytes: number
  createdAt: string
}

/**
 * Files this app has put in the destination's folder, newest first.
 *
 * Only ever sees its own uploads -- `drive.file` grants no visibility into
 * anything else in the account, which is why it was chosen.
 */
export async function listFiles(
  destId: string
): Promise<{ ok: boolean; error?: string; files: DriveFile[] }> {
  const token = await accessTokenFor(destId)
  if (!token) {
    return { ok: false, error: 'Could not reach Google Drive. Reconnect it.', files: [] }
  }

  const dest = await db.backupDestination.findUnique({
    where: { id: destId },
    select: { folderId: true },
  })
  if (!dest?.folderId) {
    // No folder yet means nothing has been uploaded -- an empty list, not an
    // error to alarm anyone with.
    return { ok: true, files: [] }
  }

  const q = encodeURIComponent(`'${dest.folderId}' in parents and trashed = false`)
  const res = await fetch(
    `${FILES_URL}?q=${q}&fields=files(id,name,size,createdTime)&orderBy=createdTime desc&pageSize=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) {
    return { ok: false, error: `Drive listing failed (HTTP ${res.status}).`, files: [] }
  }

  const data = (await res.json()) as {
    files?: Array<{ id: string; name: string; size?: string; createdTime?: string }>
  }
  return {
    ok: true,
    files: (data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      bytes: Number(f.size || 0),
      createdAt: f.createdTime || '',
    })),
  }
}

/**
 * Remove one file from the destination's folder.
 *
 * Trashes rather than hard-deletes: a mis-click on a backup should be
 * recoverable from the customer's own Drive bin, not gone.
 */
export async function deleteFile(
  destId: string,
  fileId: string
): Promise<{ ok: boolean; error?: string }> {
  const token = await accessTokenFor(destId)
  if (!token) return { ok: false, error: 'Could not reach Google Drive. Reconnect it.' }

  // Confirm the file is one of ours before touching it. drive.file already
  // limits this to app-created files, but an id arriving from a request should
  // never be passed straight through to a delete.
  const dest = await db.backupDestination.findUnique({
    where: { id: destId },
    select: { folderId: true },
  })
  const check = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}?fields=id,parents`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!check.ok) return { ok: false, error: 'That file is not in this backup folder.' }
  const meta = (await check.json()) as { parents?: string[] }
  if (dest?.folderId && !(meta.parents || []).includes(dest.folderId)) {
    return { ok: false, error: 'That file is not in this backup folder.' }
  }

  const res = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  })
  if (!res.ok) return { ok: false, error: `Could not remove the file (HTTP ${res.status}).` }
  return { ok: true }
}
