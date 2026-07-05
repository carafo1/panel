/**
 * TOTP (Time-based One-Time Password) utilities for two-factor authentication.
 *
 * Used by:
 *  - #7 2FA
 *
 * Provides secret generation, QR code rendering, token verification, and
 * backup-code hashing/verification.
 *
 * Implements RFC 6238 (TOTP) and RFC 6287 (OCRA) using otplib. Backup codes
 * are hashed with bcrypt so they can be safely stored alongside user records.
 */
import { authenticator } from 'otplib'
import QRCode from 'qrcode'
import bcryptjs from 'bcryptjs'
import { randomInt } from 'crypto'

// Configure TOTP: 6 digits, 30-second window
authenticator.options = {
  digits: 6,
  step: 30,
  window: 1, // accept tokens from the previous & current step (±30s)
}

/**
 * Generate a new random base32-encoded TOTP secret.
 */
export function generateSecret(): string {
  return authenticator.generateSecret()
}

/**
 * Generate a QR code data URL for the standard TOTP otpauth:// URI.
 * The QR code can be scanned by authenticator apps like Google Authenticator,
 * 1Password, Authy, etc.
 */
export async function generateQRCode(
  secret: string,
  email: string,
  issuer = 'Apsamo Panel'
): Promise<string> {
  const otpauthUri = authenticator.keyuri(email, issuer, secret)
  return QRCode.toDataURL(otpauthUri, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: 'M',
  })
}

/**
 * Verify a 6-digit TOTP token against the stored secret.
 * Returns true if the token is currently valid (within the time window).
 */
export function verifyToken(token: string, secret: string): boolean {
  try {
    // Strip whitespace the user might have typed
    const cleaned = token.replace(/\s+/g, '')
    return authenticator.verify({ token: cleaned, secret })
  } catch {
    return false
  }
}

/**
 * Generate a 6-digit TOTP token for the given secret (mostly useful for tests).
 */
export function generateToken(secret: string): string {
  return authenticator.generate(secret)
}

/**
 * Generate 10 single-use backup codes.
 * Format: 8-character alphanumeric, dash-separated for readability.
 * Example: "AB12-CD34"
 */
export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = []
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars
  for (let i = 0; i < count; i++) {
    let code = ''
    for (let j = 0; j < 8; j++) {
      // SECURITY: backup codes are auth credentials — use a CSPRNG, not Math.random.
      code += chars[randomInt(chars.length)]
      if (j === 3) code += '-'
    }
    codes.push(code)
  }
  return codes
}

/**
 * Hash a list of backup codes for safe storage.
 * Returns a JSON-encoded array of bcrypt hashes (each with a unique salt).
 */
export async function hashBackupCodes(codes: string[]): Promise<string> {
  const hashes: string[] = []
  for (const code of codes) {
    const hash = await bcryptjs.hash(code.toUpperCase(), 10)
    hashes.push(hash)
  }
  return JSON.stringify(hashes)
}

/**
 * Verify a backup code against a stored JSON array of bcrypt hashes.
 * Returns true if any stored hash matches.
 *
 * IMPORTANT: The caller is responsible for removing the used hash from the
 * stored JSON after this function returns true, so the same code cannot be
 * used twice. See {@link removeUsedBackupCode}.
 */
export async function verifyBackupCode(
  code: string,
  hashedCodes: string
): Promise<boolean> {
  try {
    const hashes: string[] = JSON.parse(hashedCodes)
    if (!Array.isArray(hashes)) return false
    const normalized = code.toUpperCase().trim()
    for (const hash of hashes) {
      const matches = await bcryptjs.compare(normalized, hash)
      if (matches) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Remove a used backup code from the stored JSON array.
 * Returns a new JSON string with the matching hash removed, or the original
 * string if no match was found.
 */
export async function removeUsedBackupCode(
  code: string,
  hashedCodes: string
): Promise<string> {
  try {
    const hashes: string[] = JSON.parse(hashedCodes)
    if (!Array.isArray(hashes)) return hashedCodes
    const normalized = code.toUpperCase().trim()
    const remaining: string[] = []
    let removed = false
    for (const hash of hashes) {
      if (!removed) {
        const matches = await bcryptjs.compare(normalized, hash)
        if (matches) {
          removed = true
          continue // skip - this is the used code
        }
      }
      remaining.push(hash)
    }
    return JSON.stringify(remaining)
  } catch {
    return hashedCodes
  }
}

/**
 * Verify a backup code AND remove it from storage in one call.
 * Returns `{ valid: boolean, remaining: string }` where `remaining` is the
 * updated JSON string (without the used code) that should be persisted.
 *
 * Convenience wrapper around {@link verifyBackupCode} and {@link removeUsedBackupCode}.
 */
export async function consumeBackupCode(
  code: string,
  hashedCodes: string
): Promise<{ valid: boolean; remaining: string }> {
  const valid = await verifyBackupCode(code, hashedCodes)
  if (!valid) return { valid: false, remaining: hashedCodes }
  const remaining = await removeUsedBackupCode(code, hashedCodes)
  return { valid: true, remaining }
}
