/**
 * Dynadot API keys set from the panel (Admin → Servers → Dynadot).
 *
 * Keys saved here are stored encrypted in the database and take precedence
 * over DYNADOT_API_KEY / DYNADOT_SECRET_KEY in .env, so they never need to
 * live in a file on disk or in the repository. They are copied into
 * process.env at server start (src/instrumentation.ts) and whenever an admin
 * saves or removes them, so every existing Dynadot caller picks them up
 * without a restart. Removing them falls back to the .env values.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'

const KEY_ID = 'dynadot.apiKey'
const SECRET_ID = 'dynadot.secretKey'

export class DynadotSettingsError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

// What .env said before any saved setting replaced it (kept across hot reloads).
const g = globalThis as unknown as { __dynadotEnvOriginal?: { key?: string; secret?: string } }
function envOriginal() {
  if (!g.__dynadotEnvOriginal) {
    g.__dynadotEnvOriginal = { key: process.env.DYNADOT_API_KEY, secret: process.env.DYNADOT_SECRET_KEY }
  }
  return g.__dynadotEnvOriginal
}

function setEnv(name: string, value: string | undefined) {
  if (value) process.env[name] = value
  else delete process.env[name]
}

async function readSaved(): Promise<{ key: string | null; secret: string | null }> {
  const rows = await db.appSetting.findMany({ where: { key: { in: [KEY_ID, SECRET_ID] } } }).catch(() => [])
  const get = (id: string) => {
    const v = rows.find((r) => r.key === id)?.value
    if (!v) return null
    try {
      return decrypt(v)
    } catch {
      console.error(`[dynadot-settings] ${id} could not be decrypted (ENCRYPTION_KEY changed?)`)
      return null
    }
  }
  return { key: get(KEY_ID), secret: get(SECRET_ID) }
}

/** Load saved keys into process.env (or restore the .env values when none are saved). */
export async function applyDynadotSettings(): Promise<'settings' | 'env' | null> {
  const original = envOriginal()
  const saved = await readSaved()
  if (saved.key) {
    setEnv('DYNADOT_API_KEY', saved.key)
    setEnv('DYNADOT_SECRET_KEY', saved.secret ?? undefined)
    return 'settings'
  }
  setEnv('DYNADOT_API_KEY', original.key)
  setEnv('DYNADOT_SECRET_KEY', original.secret)
  return original.key ? 'env' : null
}

const hint = (v: string | undefined | null) => (v ? `…${v.slice(-4)}` : null)

export async function dynadotStatus() {
  const original = envOriginal()
  const saved = await readSaved()
  const source = saved.key ? 'settings' : original.key ? 'env' : null
  return {
    source,
    keyHint: hint(saved.key ?? original.key),
    hasSecret: Boolean(saved.key ? saved.secret : original.secret),
    envHasKey: Boolean(original.key),
  }
}

export async function saveDynadotSettings(input: { apiKey?: unknown; secretKey?: unknown }, userId: string) {
  envOriginal()
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  const secretKey = typeof input.secretKey === 'string' ? input.secretKey.trim() : ''
  if (!/^[A-Za-z0-9]{20,100}$/.test(apiKey)) throw new DynadotSettingsError('Paste the Dynadot API key (letters and numbers only).')
  if (secretKey && !/^[A-Za-z0-9]{16,200}$/.test(secretKey)) throw new DynadotSettingsError('The secret key should be letters and numbers only.')

  const writes = [
    db.appSetting.upsert({ where: { key: KEY_ID }, create: { key: KEY_ID, value: encrypt(apiKey), updatedBy: userId }, update: { value: encrypt(apiKey), updatedBy: userId } }),
    secretKey
      ? db.appSetting.upsert({ where: { key: SECRET_ID }, create: { key: SECRET_ID, value: encrypt(secretKey), updatedBy: userId }, update: { value: encrypt(secretKey), updatedBy: userId } })
      : db.appSetting.deleteMany({ where: { key: SECRET_ID } }),
  ]
  await db.$transaction(writes)
  await applyDynadotSettings()
  return dynadotStatus()
}

export async function clearDynadotSettings() {
  await db.appSetting.deleteMany({ where: { key: { in: [KEY_ID, SECRET_ID] } } })
  await applyDynadotSettings()
  return dynadotStatus()
}

/**
 * Read-only check: one availability search. Never registers or changes anything.
 * When Dynadot refuses the caller's address, returns that address so the admin
 * knows exactly what to add to Dynadot's API allow-list.
 */
export async function testDynadot(): Promise<{ ok: boolean; message: string; blockedIp: string | null }> {
  if (!process.env.DYNADOT_API_KEY) return { ok: false, message: 'No Dynadot API key is set.', blockedIp: null }
  const { searchDomains } = await import('@/lib/dynadot')
  try {
    await searchDomains([`apsamo-connection-check-${crypto.randomBytes(3).toString('hex')}.com`])
    return { ok: true, message: 'Dynadot accepted the key from this server.', blockedIp: null }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const msg = raw.replace(/key=[^&\s]+/g, 'key=***')
    const ip = /unauthorized ip address:?\s*([0-9a-f.:]+)/i.exec(msg)?.[1] ?? null
    return {
      ok: false,
      message: ip ? `Dynadot refused this server's address (${ip}). Add it to the API allow-list in your Dynadot account.` : msg.slice(0, 300),
      blockedIp: ip,
    }
  }
}
