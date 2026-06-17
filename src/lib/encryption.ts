/**
 * AES-256-GCM encryption utilities for securing sensitive data
 * such as environment variable values, API tokens, and credentials.
 *
 * Used by:
 *  - #9 Env Var Encryption (EnvironmentVariable model)
 *  - Anywhere sensitive data needs to be stored at rest
 */
import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // 96-bit IV is recommended for GCM
const TAG_LENGTH = 16 // 128-bit auth tag
const KEY_LENGTH = 32 // 256-bit key

/**
 * Resolve the encryption key. If ENCRYPTION_KEY is unset (typical for local dev),
 * we generate a deterministic key derived from JWT_SECRET or a fixed dev string
 * and log a loud warning so it is never accidentally used in production.
 */
function getKey(): Buffer {
  const configured = process.env.ENCRYPTION_KEY
  if (configured) {
    // The env var must be a 64-char hex string (32 bytes).
    if (configured.length !== 64 || !/^[0-9a-fA-F]+$/.test(configured)) {
      throw new Error(
        'ENCRYPTION_KEY must be a 32-byte hex string (64 hex characters).'
      )
    }
    return Buffer.from(configured, 'hex')
  }

  // Demo mode - derive a deterministic key. NEVER use in production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'ENCRYPTION_KEY env var is required in production. Set it to a 32-byte hex string.'
    )
  }

  if (!getKeyWarningLogged) {
     
    console.warn(
      '\x1b[33m[encryption] WARNING: ENCRYPTION_KEY is not set. ' +
        'Using a deterministic dev-only key. Set ENCRYPTION_KEY to a 32-byte ' +
        'hex string for production use.\x1b[0m'
    )
    getKeyWarningLogged = true
  }

  const seed = process.env.JWT_SECRET || 'deployhub-dev-encryption-key-not-for-prod'
  return crypto.createHash('sha256').update(seed).digest()
}

let getKeyWarningLogged = false

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Output format: base64(IV || ciphertext || authTag)
 */
export function encrypt(text: string): string {
  if (text == null) return ''
  const key = getKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

  const ciphertext = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  const combined = Buffer.concat([iv, ciphertext, authTag])
  return combined.toString('base64')
}

/**
 * Decrypt a string produced by {@link encrypt}.
 */
export function decrypt(encrypted: string): string {
  if (!encrypted) return ''
  const key = getKey()

  const combined = Buffer.from(encrypted, 'base64')
  if (combined.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid encrypted payload: too short')
  }

  const iv = combined.subarray(0, IV_LENGTH)
  const authTag = combined.subarray(combined.length - TAG_LENGTH)
  const ciphertext = combined.subarray(
    IV_LENGTH,
    combined.length - TAG_LENGTH
  )

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}

/**
 * Encrypt an arbitrary JSON-serializable value.
 */
export function encryptJSON(obj: unknown): string {
  return encrypt(JSON.stringify(obj))
}

/**
 * Decrypt a JSON string produced by {@link encryptJSON} and return the parsed value.
 */
export function decryptJSON<T = unknown>(str: string): T {
  const json = decrypt(str)
  return JSON.parse(json) as T
}

/**
 * Generate a new random 32-byte encryption key encoded as hex.
 * Useful for first-time setup instructions.
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString('hex')
}
