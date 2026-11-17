/**
 * Public SSH keys customers add to their account (Settings → SSH keys) and
 * grant to a website's SFTP access. Only the public half is ever stored.
 *
 * A key is parsed, not just pattern-matched: the base64 blob must decode to
 * the algorithm it claims, RSA keys must be at least 2048 bits, and options or
 * comments the customer pasted are dropped — the server writes its own
 * `restrict` options in front of every key.
 */
import crypto from 'crypto'

export class SshKeyError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

const ALLOWED = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
])

/** Read one SSH wire-format string (uint32 length + bytes). */
function readString(buf: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > buf.length) throw new SshKeyError('That key is truncated.')
  const len = buf.readUInt32BE(offset)
  const end = offset + 4 + len
  if (len > 16384 || end > buf.length) throw new SshKeyError('That key is truncated.')
  return { value: buf.subarray(offset + 4, end), next: end }
}

export interface ParsedKey {
  type: string
  /** "type base64" — no options, no comment. */
  normalized: string
  fingerprint: string
  bits: number | null
  comment: string
}

export function parsePublicKey(input: string): ParsedKey {
  const text = (input || '').trim()
  if (!text) throw new SshKeyError('Paste your public key.')
  if (/PRIVATE KEY/.test(text)) {
    throw new SshKeyError('That is a PRIVATE key. Never share it — paste the matching .pub file instead.')
  }
  if (text.includes('\n')) throw new SshKeyError('Paste one key at a time (a single line).')
  if (text.length > 16384) throw new SshKeyError('That key is too long.')

  // Allow options before the type (as in authorized_keys); find the type token.
  const parts = text.split(/\s+/)
  const at = parts.findIndex((p) => ALLOWED.has(p))
  if (at === -1 || !parts[at + 1]) {
    throw new SshKeyError('Unsupported key. Use an ed25519 (recommended), ECDSA or RSA public key, e.g. the contents of ~/.ssh/id_ed25519.pub.')
  }
  const type = parts[at]
  const b64 = parts[at + 1]
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(b64)) throw new SshKeyError('That key is not valid base64.')
  const blob = Buffer.from(b64, 'base64')
  if (blob.toString('base64').replace(/=+$/, '') !== b64.replace(/=+$/, '')) throw new SshKeyError('That key is not valid base64.')

  const first = readString(blob, 0)
  if (first.value.toString('latin1') !== type) throw new SshKeyError('The key data does not match its type — it may be damaged.')

  let bits: number | null = null
  if (type === 'ssh-rsa') {
    const e = readString(blob, first.next)
    const n = readString(blob, e.next)
    let mod = n.value
    while (mod.length && mod[0] === 0) mod = mod.subarray(1)
    bits = mod.length * 8 - (mod.length ? Math.clz32(mod[0]) - 24 : 0)
    if (bits < 2048) throw new SshKeyError(`This RSA key is ${bits} bits. Use at least 2048 bits, or better, an ed25519 key.`)
  } else if (type === 'ssh-ed25519' || type === 'sk-ssh-ed25519@openssh.com') {
    const k = readString(blob, first.next)
    if (k.value.length !== 32) throw new SshKeyError('That ed25519 key is damaged.')
    bits = 256
  } else {
    const curve = readString(blob, first.next).value.toString('latin1')
    if (!type.includes(curve)) throw new SshKeyError('That ECDSA key is damaged.')
    bits = Number(curve.replace('nistp', '')) || null
  }

  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  const comment = parts.slice(at + 2).join(' ').slice(0, 100)
  return { type, normalized: `${type} ${blob.toString('base64')}`, fingerprint, bits, comment }
}
