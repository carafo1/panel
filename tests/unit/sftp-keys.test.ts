/**
 * Client-side SSH key helpers used by the SFTP tab (src/lib/sftp-keys.ts).
 *
 * The validator must agree with the server's parser (src/lib/ssh-keys.ts),
 * and the keys the browser generates must be readable by real OpenSSH. Where
 * `ssh-keygen` is installed, the generated private key is fed to it.
 */
import { describe, it, expect } from 'bun:test'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bytesToBase64,
  base64ToBytes,
  base64UrlToBytes,
  sshString,
  checkPublicKey,
  describeKey,
  encodeEd25519PublicKey,
  encodeEd25519PrivateKey,
  ed25519PublicBlob,
  fingerprint,
  generateEd25519KeyPair,
  cleanComment,
} from '../../src/lib/sftp-keys'
import { parsePublicKey } from '../../src/lib/ssh-keys'

// RFC 8032 §7.1, test 1.
const SEED = Uint8Array.from(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'))
const PUB = Uint8Array.from(Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex'))

const b64url = (s: string) => Uint8Array.from(Buffer.from(s, 'base64url'))

function rsaKey(bits: number): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: bits })
  const jwk = publicKey.export({ format: 'jwk' })
  const withSign = (b: Uint8Array) => (b[0] & 0x80 ? Uint8Array.from([0, ...b]) : b)
  const blob = Buffer.concat([sshString('ssh-rsa'), sshString(withSign(b64url(jwk.e!))), sshString(withSign(b64url(jwk.n!)))])
  return `ssh-rsa ${blob.toString('base64')} rsa@test`
}

function ecdsaKey(curve: 'P-256' | 'P-384' | 'P-521'): string {
  const name = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' }[curve]
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: curve })
  const jwk = publicKey.export({ format: 'jwk' })
  const point = Buffer.concat([Buffer.from([4]), b64url(jwk.x!), b64url(jwk.y!)])
  const blob = Buffer.concat([sshString(`ecdsa-sha2-${name}`), sshString(name), sshString(point)])
  return `ecdsa-sha2-${name} ${blob.toString('base64')}`
}

/** Reads back an "openssh-key-v1" file, enough to check our own output. */
function parsePrivate(pem: string) {
  const b64 = pem.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const buf = Buffer.from(b64, 'base64')
  let o = 0
  const u32 = () => {
    const v = buf.readUInt32BE(o)
    o += 4
    return v
  }
  const str = () => {
    const n = u32()
    const v = buf.subarray(o, o + n)
    o += n
    return v
  }
  const magic = buf.subarray(0, 15).toString('latin1')
  o = 15
  const out = { magic, cipher: str().toString(), kdf: str().toString(), kdfOpts: str(), count: u32(), pub: str(), priv: str(), rest: buf.length - o }
  const p = out.priv
  let q = 0
  const pu32 = () => {
    const v = p.readUInt32BE(q)
    q += 4
    return v
  }
  const pstr = () => {
    const n = pu32()
    const v = p.subarray(q, q + n)
    q += n
    return v
  }
  const inner = { check1: pu32(), check2: pu32(), type: pstr().toString(), pub: pstr(), secret: pstr(), comment: pstr().toString(), padding: [...p.subarray(q)] }
  return { ...out, inner, lines: pem.trim().split('\n') }
}

describe('base64 helpers', () => {
  it('round-trips every length and matches Buffer', () => {
    for (let len = 0; len < 40; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 0xff)
      const b64 = bytesToBase64(bytes)
      expect(b64).toBe(Buffer.from(bytes).toString('base64'))
      expect([...(base64ToBytes(b64) ?? [])]).toEqual([...bytes])
    }
  })
  it('rejects invalid base64', () => {
    expect(base64ToBytes('ab$c')).toBeNull()
    expect(base64ToBytes('a')).toBeNull()
  })
  it('decodes base64url (JWK)', () => {
    expect([...(base64UrlToBytes(Buffer.from(PUB).toString('base64url')) ?? [])]).toEqual([...PUB])
  })
})

describe('OpenSSH public key encoding', () => {
  it('encodes an Ed25519 key the server parser accepts with the same fingerprint', () => {
    const line = encodeEd25519PublicKey(PUB, 'me@laptop')
    expect(line.startsWith('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI')).toBe(true)
    expect(line.endsWith(' me@laptop')).toBe(true)
    const server = parsePublicKey(line)
    expect(server.type).toBe('ssh-ed25519')
    expect(server.comment).toBe('me@laptop')
    const blob = ed25519PublicBlob(PUB)
    expect(server.fingerprint).toBe('SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''))
  })
  it('makes the fingerprint the server shows', async () => {
    const server = parsePublicKey(encodeEd25519PublicKey(PUB))
    expect(await fingerprint(ed25519PublicBlob(PUB))).toBe(server.fingerprint)
  })
  it('keeps comments to one printable token', () => {
    expect(cleanComment('my key\n😀 2026')).toBe('my-key-2026')
    expect(encodeEd25519PublicKey(PUB, '').split(' ')).toHaveLength(2)
  })
  it('refuses keys of the wrong length', () => {
    expect(() => encodeEd25519PublicKey(PUB.subarray(1))).toThrow()
  })
})

describe('OpenSSH private key encoding', () => {
  const pem = encodeEd25519PrivateKey(PUB, SEED, 'me@laptop', 0x01020304)
  const k = parsePrivate(pem)

  it('has the openssh-key-v1 structure, unencrypted', () => {
    expect(k.lines[0]).toBe('-----BEGIN OPENSSH PRIVATE KEY-----')
    expect(k.lines.at(-1)).toBe('-----END OPENSSH PRIVATE KEY-----')
    expect(k.lines.slice(1, -1).every((l) => l.length <= 70)).toBe(true)
    expect(k.magic).toBe('openssh-key-v1\0')
    expect(k.cipher).toBe('none')
    expect(k.kdf).toBe('none')
    expect(k.kdfOpts.length).toBe(0)
    expect(k.count).toBe(1)
    expect(k.rest).toBe(0)
    expect([...k.pub]).toEqual([...ed25519PublicBlob(PUB)])
  })
  it('stores seed||public, the check ints and the comment, padded to 8', () => {
    expect(k.inner.check1).toBe(0x01020304)
    expect(k.inner.check2).toBe(0x01020304)
    expect(k.inner.type).toBe('ssh-ed25519')
    expect([...k.inner.pub]).toEqual([...PUB])
    expect([...k.inner.secret]).toEqual([...SEED, ...PUB])
    expect(k.inner.comment).toBe('me@laptop')
    expect(k.priv.length % 8).toBe(0)
    expect(k.inner.padding).toEqual(k.inner.padding.map((_, i) => i + 1))
  })
})

describe('browser key generation (Web Crypto)', () => {
  it('produces a matching pair the server accepts', async () => {
    const pair = await generateEd25519KeyPair('website 2026-11-24')
    const server = parsePublicKey(pair.publicKey)
    expect(server.type).toBe('ssh-ed25519')
    expect(server.comment).toBe('website-2026-11-24')
    expect(pair.fingerprint).toBe(server.fingerprint)
    const k = parsePrivate(pair.privateKey)
    expect(k.inner.pub.toString('base64')).toBe(k.inner.secret.subarray(32).toString('base64'))
    expect(`ssh-ed25519 ${k.pub.toString('base64')}`).toBe(server.normalized)
  })

  // ssh-keygen -y derives the public key from the private key file, so this
  // proves real OpenSSH can read what the browser offers for download.
  const sshKeygen = Bun.which('ssh-keygen')
  it.skipIf(!sshKeygen)('is readable by ssh-keygen', async () => {
    const pair = await generateEd25519KeyPair('roundtrip')
    const dir = mkdtempSync(join(tmpdir(), 'sftp-keys-'))
    try {
      const file = join(dir, 'id_ed25519')
      writeFileSync(file, pair.privateKey, { mode: 0o600 })
      const r = Bun.spawnSync([sshKeygen!, '-y', '-f', file])
      const out = r.stdout.toString().trim()
      if (r.exitCode !== 0 && /UNPROTECTED|permissions/i.test(r.stderr.toString())) {
        console.warn('ssh-keygen refused the temp file permissions; structure tests still apply')
        return
      }
      expect(r.exitCode).toBe(0)
      expect(out.split(' ').slice(0, 2).join(' ')).toBe(pair.publicKey.split(' ').slice(0, 2).join(' '))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('checkPublicKey (mirrors the server)', () => {
  const agree = (line: string) => {
    const client = checkPublicKey(line)
    let serverError: string | null = null
    let normalized: string | null = null
    try {
      normalized = parsePublicKey(line).normalized
    } catch (e) {
      serverError = (e as Error).message
    }
    return { client, serverError, normalized }
  }

  it('accepts ed25519, with options and comments, like the server', () => {
    const line = `restrict,no-pty ${encodeEd25519PublicKey(PUB, 'a b c')}`
    const { client, serverError, normalized } = agree(line)
    expect(serverError).toBeNull()
    expect(client.ok).toBe(true)
    if (client.ok) {
      expect(client.type).toBe('ssh-ed25519')
      expect(client.bits).toBe(256)
      expect(client.comment).toBe('a-b-c')
      expect(client.normalized).toBe(normalized!)
    }
  })

  it('accepts RSA 2048+ and rejects smaller, with the server message', () => {
    const ok = agree(rsaKey(2048))
    expect(ok.serverError).toBeNull()
    expect(ok.client.ok && ok.client.bits).toBe(2048)

    const weak = agree(rsaKey(1024))
    expect(weak.client.ok).toBe(false)
    expect(!weak.client.ok && weak.client.error).toBe(weak.serverError!)
    expect(weak.serverError).toContain('1024 bits')
  })

  it('accepts every ECDSA curve', () => {
    for (const [curve, bits] of [['P-256', 256], ['P-384', 384], ['P-521', 521]] as const) {
      const r = agree(ecdsaKey(curve))
      expect(r.serverError).toBeNull()
      expect(r.client.ok && r.client.bits).toBe(bits)
      expect(r.client.ok && r.client.normalized).toBe(r.normalized!)
    }
  })

  it('gives friendly errors that match the server for bad input', () => {
    const blob = Buffer.from(ed25519PublicBlob(PUB))
    const cases = [
      '',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
      'ssh-ed25519 AAAA one\nssh-ed25519 AAAA two',
      'hello world',
      'ssh-ed25519',
      'ssh-ed25519 not*base64',
      `ssh-rsa ${blob.toString('base64')}`, // type mismatch
      `ssh-ed25519 ${blob.subarray(0, blob.length - 3).toString('base64')}`, // truncated
      `ssh-ed25519 ${Buffer.concat([sshString('ssh-ed25519'), sshString(PUB.subarray(0, 31))]).toString('base64')}`,
    ]
    for (const line of cases) {
      const { client, serverError } = agree(line)
      expect(serverError).not.toBeNull()
      expect(client.ok).toBe(false)
      if (!client.ok) expect(client.error).toBe(serverError!)
    }
  })

  it('explains PuTTY formats and DSA keys', () => {
    const ppk = checkPublicKey('PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none')
    expect(!ppk.ok && ppk.error).toContain('PRIVATE')
    const ssh2 = checkPublicKey('---- BEGIN SSH2 PUBLIC KEY ----\nAAAA\n---- END SSH2 PUBLIC KEY ----')
    expect(!ssh2.ok && ssh2.error).toContain('PuTTYgen')
    const dsa = checkPublicKey('ssh-dss AAAAB3NzaC1kc3MAAACB')
    expect(!dsa.ok && dsa.error).toContain('DSA')
  })

  it('describes key types for people', () => {
    expect(describeKey('ssh-ed25519', 256)).toBe('Ed25519')
    expect(describeKey('ssh-rsa', 4096)).toBe('RSA 4096-bit')
    expect(describeKey('ecdsa-sha2-nistp384', 384)).toBe('ECDSA P-384')
  })
})
