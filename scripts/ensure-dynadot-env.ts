/**
 * ensure-dynadot-env.ts
 *
 * GUARANTEES that DYNADOT_API_KEY and DYNADOT_SECRET_KEY are present in
 * /home/z/my-project/.env. If either is missing, restores them from one of:
 *   1. /home/z/my-project/.env.dynadot        (project-local backup)
 *   2. /home/z/.apsamo-secrets.env             (user-home backup, survives resets)
 *
 * Designed to be run as a `predev` hook so the dev server ALWAYS starts with
 * the keys present. Idempotent: if keys are already there, does nothing.
 *
 * Usage:
 *   bun run scripts/ensure-dynadot-env.ts
 *   (or automatically via `bun run dev` -> predev hook in package.json)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const ENV_PATH = '/home/z/my-project/.env'
const PROJECT_BACKUP = '/home/z/my-project/.env.dynadot'
const HOME_BACKUP = '/home/z/.apsamo-secrets.env'

// Hardcoded fallback — the actual production keys. Used ONLY if both backup
// files are also missing (e.g. fresh clone with no backups). This is the
// final safety net so the keys can never be lost as long as this script exists.
const HARDCODED_FALLBACK = {
  DYNADOT_API_KEY: '9N7B8O7q8j6w7fgD6Eq6j7l7M6E7d9Rs8x7HPS16L',
  DYNADOT_SECRET_KEY: '97a4d6d09699f88e5d709cf37ad6ed2a9b82fd710fa173f72443abe0abd55a7f',
}

function readBackupKeys(): Record<string, string> {
  for (const f of [PROJECT_BACKUP, HOME_BACKUP]) {
    try {
      const txt = fs.readFileSync(f, 'utf8')
      const out: Record<string, string> = {}
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*(DYNADOT_API_KEY|DYNADOT_SECRET_KEY)\s*=\s*(\S+)\s*$/)
        if (m) out[m[1]] = m[2]
      }
      if (out.DYNADOT_API_KEY && out.DYNADOT_SECRET_KEY) {
        console.log(`[ensure-dynadot-env] loaded keys from ${f}`)
        return out
      }
    } catch {
      // try next backup
    }
  }
  console.log('[ensure-dynadot-env] no backup files found, using hardcoded fallback')
  return HARDCODED_FALLBACK
}

function main() {
  let envText = ''
  try {
    envText = fs.readFileSync(ENV_PATH, 'utf8')
  } catch {
    envText = ''
  }

  const lines = envText.split('\n')
  const hasApiKey = /^\s*DYNADOT_API_KEY\s*=/.test(envText)
  const hasSecretKey = /^\s*DYNADOT_SECRET_KEY\s*=/.test(envText)

  if (hasApiKey && hasSecretKey) {
    console.log('[ensure-dynadot-env] OK — both Dynadot keys already present in .env')
    return
  }

  console.log('[ensure-dynadot-env] Dynadot keys missing from .env — restoring...')
  const keys = readBackupKeys()

  // Remove any stale partial entries
  const filtered = lines.filter((l) => !/^\s*(DYNADOT_API_KEY|DYNADOT_SECRET_KEY)\s*=/.test(l))

  // Append a clean block
  const block = [
    '',
    '# === Dynadot API Credentials (auto-restored by ensure-dynadot-env.ts) ===',
    `DYNADOT_API_KEY=${keys.DYNADOT_API_KEY}`,
    `DYNADOT_SECRET_KEY=${keys.DYNADOT_SECRET_KEY}`,
    '',
  ]
  const newText = filtered.join('\n').replace(/\n+$/, '\n') + block.join('\n')
  fs.writeFileSync(ENV_PATH, newText, { mode: 0o644 })
  console.log(`[ensure-dynadot-env] ✅ Restored Dynadot keys to ${ENV_PATH}`)

  // Also ensure backup files exist (re-create them if missing)
  try {
    if (!fs.existsSync(PROJECT_BACKUP)) {
      fs.writeFileSync(
        PROJECT_BACKUP,
        `# Dynadot API Credentials — PERMANENT BACKUP\nDYNADOT_API_KEY=${keys.DYNADOT_API_KEY}\nDYNADOT_SECRET_KEY=${keys.DYNADOT_SECRET_KEY}\n`,
        { mode: 0o644 }
      )
      console.log(`[ensure-dynadot-env] ✅ Re-created project backup at ${PROJECT_BACKUP}`)
    }
    if (!fs.existsSync(HOME_BACKUP)) {
      fs.writeFileSync(
        HOME_BACKUP,
        `# APSAMO PRODUCTION SECRETS — PERMANENT BACKUP\nDYNADOT_API_KEY=${keys.DYNADOT_API_KEY}\nDYNADOT_SECRET_KEY=${keys.DYNADOT_SECRET_KEY}\n`,
        { mode: 0o644 }
      )
      console.log(`[ensure-dynadot-env] ✅ Re-created home backup at ${HOME_BACKUP}`)
    }
  } catch (e) {
    console.warn(`[ensure-dynadot-env] warning: could not write backups: ${(e as Error).message}`)
  }
}

main()
