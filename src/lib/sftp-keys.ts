/**
 * Client-safe SSH key helpers for the SFTP tab.
 *
 * No Node APIs (Buffer, crypto) so this runs in the browser as well as in
 * unit tests. Two jobs:
 *
 *   1. Validate a pasted public key with the SAME rules the server applies in
 *      src/lib/ssh-keys.ts (parsePublicKey), and the same messages, so the
 *      customer sees the problem before submitting.
 *   2. Encode an Ed25519 key pair made with Web Crypto into OpenSSH formats:
 *      the one-line public key ("ssh-ed25519 AAAA… comment") and the
 *      unencrypted "-----BEGIN OPENSSH PRIVATE KEY-----" file that FileZilla,
 *      WinSCP, Cyberduck and the OpenSSH `sftp` command all read.
 *
 * The private key is only ever produced as a string for a local file
 * download. Nothing here sends, logs or stores it.
 */

// ── Base64 ────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

/** Strict standard base64 (no whitespace). Returns null when invalid. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
  const clean = text.replace(/=+$/, '')
  if (clean.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let value = 0
  let o = 0
  for (const ch of clean) {
    value = (value << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (value >> bits) & 0xff
    }
  }
  return out
}

/** base64url (JWK) → bytes. */
export function base64UrlToBytes(text: string): Uint8Array | null {
  const std = text.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(std + '='.repeat((4 - (std.length % 4)) % 4))
}

// ── SSH wire format ───────────────────────────────────────────────────

const enc = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function sshUint32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

/** An SSH "string": uint32 big-endian length, then the bytes. */
export function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === 'string' ? enc.encode(value) : value
  return concat(sshUint32(bytes.length), bytes)
}

function readString(buf: Uint8Array, offset: number): { value: Uint8Array; next: number } {
  if (offset + 4 > buf.length) throw new KeyCheckError('That key is truncated.')
  const len = ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
  const end = offset + 4 + len
  if (len > 16384 || end > buf.length) throw new KeyCheckError('That key is truncated.')
  return { value: buf.subarray(offset + 4, end), next: end }
}

const latin1 = (b: Uint8Array) => String.fromCharCode(...b)

// ── Public key validation (mirrors src/lib/ssh-keys.ts) ───────────────

class KeyCheckError extends Error {}

/** Key types the server accepts. Keep in sync with ALLOWED in src/lib/ssh-keys.ts. */
export const ALLOWED_KEY_TYPES = [
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
] as const

const ALLOWED = new Set<string>(ALLOWED_KEY_TYPES)
export const MIN_RSA_BITS = 2048

export type PublicKeyCheck =
  | { ok: true; type: string; bits: number | null; comment: string; normalized: string; blob: Uint8Array }
  | { ok: false; error: string }

/** A short human label for a key type, e.g. "Ed25519" or "RSA 4096-bit". */
export function describeKey(type: string, bits: number | null): string {
  if (type.includes('ed25519')) return type.startsWith('sk-') ? 'Ed25519 security key' : 'Ed25519'
  if (type === 'ssh-rsa') return bits ? `RSA ${bits}-bit` : 'RSA'
  if (type.includes('ecdsa')) return `${type.startsWith('sk-') ? 'ECDSA security key' : 'ECDSA'}${bits ? ` P-${bits}` : ''}`
  return type
}

/**
 * Check a pasted public key the way the server will. Returns a friendly error
 * instead of throwing. `ok: true` does not guarantee the server accepts it
 * (duplicates and the 20-key limit are checked there), only that it is valid.
 */
export function checkPublicKey(input: string): PublicKeyCheck {
  try {
    return { ok: true, ...parse(input) }
  } catch (e) {
    if (e instanceof KeyCheckError) return { ok: false, error: e.message }
    throw e
  }
}

function parse(input: string) {
  const text = (input || '').trim()
  if (!text) throw new KeyCheckError('Paste your public key.')
  if (/PRIVATE KEY/.test(text) || /^PuTTY-User-Key-File/m.test(text)) {
    throw new KeyCheckError('That is a PRIVATE key. Never share it — paste the matching .pub file instead.')
  }
  if (/^---- BEGIN SSH2 PUBLIC KEY ----/.test(text)) {
    throw new KeyCheckError('That is a PuTTY-style public key. In PuTTYgen, copy the one line under “Public key for pasting into OpenSSH authorized_keys file” instead.')
  }
  if (text.includes('\n')) throw new KeyCheckError('Paste one key at a time (a single line).')
  if (text.length > 16384) throw new KeyCheckError('That key is too long.')

  const parts = text.split(/\s+/)
  const at = parts.findIndex((p) => ALLOWED.has(p))
  if (at === -1 || !parts[at + 1]) {
    if (/^ssh-dss\b/.test(text)) throw new KeyCheckError('DSA keys are no longer secure and are not accepted. Create an ed25519 key instead.')
    throw new KeyCheckError('Unsupported key. Use an ed25519 (recommended), ECDSA or RSA public key, e.g. the contents of ~/.ssh/id_ed25519.pub.')
  }
  const type = parts[at]
  const b64 = parts[at + 1]
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(b64)) throw new KeyCheckError('That key is not valid base64.')
  const blob = base64ToBytes(b64)
  if (!blob || bytesToBase64(blob).replace(/=+$/, '') !== b64.replace(/=+$/, '')) throw new KeyCheckError('That key is not valid base64.')

  const first = readString(blob, 0)
  if (latin1(first.value) !== type) throw new KeyCheckError('The key data does not match its type — it may be damaged.')

  let bits: number | null = null
  if (type === 'ssh-rsa') {
    const e = readString(blob, first.next)
    const n = readString(blob, e.next)
    let mod = n.value
    while (mod.length && mod[0] === 0) mod = mod.subarray(1)
    bits = mod.length * 8 - (mod.length ? Math.clz32(mod[0]) - 24 : 0)
    if (bits < MIN_RSA_BITS) throw new KeyCheckError(`This RSA key is ${bits} bits. Use at least ${MIN_RSA_BITS} bits, or better, an ed25519 key.`)
  } else if (type === 'ssh-ed25519' || type === 'sk-ssh-ed25519@openssh.com') {
    const k = readString(blob, first.next)
    if (k.value.length !== 32) throw new KeyCheckError('That ed25519 key is damaged.')
    bits = 256
  } else {
    const curve = latin1(readString(blob, first.next).value)
    if (!type.includes(curve)) throw new KeyCheckError('That ECDSA key is damaged.')
    bits = Number(curve.replace('nistp', '')) || null
  }

  const comment = parts.slice(at + 2).join(' ').slice(0, 100)
  return { type, bits, comment, normalized: `${type} ${bytesToBase64(blob)}`, blob }
}

/** "SHA256:…" exactly as the server and `ssh-keygen -l` print it. */
export async function fingerprint(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', blob as BufferSource))
  return 'SHA256:' + bytesToBase64(digest).replace(/=+$/, '')
}

// ── Ed25519 → OpenSSH encoding ────────────────────────────────────────

/** Comments end up in a file and a one-line key: keep them printable and short. */
export function cleanComment(comment: string): string {
  return comment.replace(/[^\x21-\x7e ]/g, '').replace(/\s+/g, '-').slice(0, 60)
}

export function ed25519PublicBlob(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) throw new Error('An Ed25519 public key is 32 bytes')
  return concat(sshString('ssh-ed25519'), sshString(publicKey))
}

/** The one-line OpenSSH public key: "ssh-ed25519 AAAA… comment". */
export function encodeEd25519PublicKey(publicKey: Uint8Array, comment = ''): string {
  const c = cleanComment(comment)
  return `ssh-ed25519 ${bytesToBase64(ed25519PublicBlob(publicKey))}${c ? ` ${c}` : ''}`
}

/**
 * An unencrypted OpenSSH private key file (PROTOCOL.key, "openssh-key-v1").
 * `seed` is the 32-byte Ed25519 private key (JWK "d"); OpenSSH stores it
 * followed by the public key as one 64-byte value. `checkInt` is any random
 * uint32 — it is written twice and lets readers detect a wrong passphrase.
 */
export function encodeEd25519PrivateKey(publicKey: Uint8Array, seed: Uint8Array, comment: string, checkInt: number): string {
  if (publicKey.length !== 32 || seed.length !== 32) throw new Error('Ed25519 keys are 32 bytes')
  const pubBlob = ed25519PublicBlob(publicKey)
  let priv = concat(
    sshUint32(checkInt),
    sshUint32(checkInt),
    sshString('ssh-ed25519'),
    sshString(publicKey),
    sshString(concat(seed, publicKey)),
    sshString(cleanComment(comment)),
  )
  // Pad with 1, 2, 3… to the cipher block size (8 for "none").
  const pad = (8 - (priv.length % 8)) % 8
  priv = concat(priv, Uint8Array.from({ length: pad }, (_, i) => i + 1))

  const body = concat(
    enc.encode('openssh-key-v1\0'),
    sshString('none'), // cipher
    sshString('none'), // kdf
    sshString(new Uint8Array(0)), // kdf options
    sshUint32(1), // number of keys
    sshString(pubBlob),
    sshString(priv),
  )
  const b64 = bytesToBase64(body)
  const lines = b64.match(/.{1,70}/g) ?? []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

// ── Browser key generation ────────────────────────────────────────────

export interface GeneratedKeyPair {
  publicKey: string
  privateKey: string
  fingerprint: string
}

export class KeyGenUnsupportedError extends Error {}

/**
 * Make an Ed25519 key pair with Web Crypto. Throws KeyGenUnsupportedError
 * when the browser cannot (no secure context, or no Ed25519 support), so the
 * caller can show ssh-keygen / PuTTYgen instructions instead.
 */
export async function generateEd25519KeyPair(comment: string): Promise<GeneratedKeyPair> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new KeyGenUnsupportedError('This page is not in a secure context, so the browser cannot create keys.')
  let pair: CryptoKeyPair
  try {
    pair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  } catch {
    throw new KeyGenUnsupportedError('This browser cannot create Ed25519 keys.')
  }
  const jwk = await subtle.exportKey('jwk', pair.privateKey)
  const pub = jwk.x ? base64UrlToBytes(jwk.x) : null
  const seed = jwk.d ? base64UrlToBytes(jwk.d) : null
  if (!pub || !seed || pub.length !== 32 || seed.length !== 32) throw new KeyGenUnsupportedError('This browser returned an unexpected key format.')

  const check = new Uint32Array(1)
  globalThis.crypto.getRandomValues(check)
  const publicKey = encodeEd25519PublicKey(pub, comment)
  const privateKey = encodeEd25519PrivateKey(pub, seed, comment, check[0])
  seed.fill(0)
  return { publicKey, privateKey, fingerprint: await fingerprint(ed25519PublicBlob(pub)) }
}
