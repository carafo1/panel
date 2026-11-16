/**
 * ensure-dynadot-env.ts
 *
 * Runs as the `predev` hook. If DYNADOT_API_KEY / DYNADOT_SECRET_KEY are
 * missing from the project's .env, restores them from a private backup file:
 *   1. <project>/.env.dynadot         (gitignored by the `.env.*` rule)
 *   2. ~/.apsamo-secrets.env          (outside the repo, survives re-clones)
 *
 * It NEVER contains keys itself. Credentials must not live in source control:
 * an earlier version of this script embedded the production keys as a
 * "fallback", which published them to everyone with read access to the repo.
 * If neither backup exists the panel simply starts with domain features in
 * demo mode — add the keys to .env (or one of the backups) to enable them.
 *
 * Usage:
 *   bun run scripts/ensure-dynadot-env.ts
 *   (or automatically via `bun run dev` -> predev hook in package.json)
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const PROJECT_DIR = path.join(import.meta.dir, '..')
const ENV_PATH = path.join(PROJECT_DIR, '.env')
const BACKUPS = [path.join(PROJECT_DIR, '.env.dynadot'), path.join(os.homedir(), '.apsamo-secrets.env')]
const KEY_LINE = /^\s*(DYNADOT_API_KEY|DYNADOT_SECRET_KEY)\s*=\s*(\S+)\s*$/

type Keys = { DYNADOT_API_KEY: string; DYNADOT_SECRET_KEY: string }

function readKeys(file: string): Partial<Keys> {
  const out: Partial<Keys> = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(KEY_LINE)
      if (m) out[m[1] as keyof Keys] = m[2]
    }
  } catch {
    // missing or unreadable — treated as "no keys here"
  }
  return out
}

function main() {
  const current = readKeys(ENV_PATH)
  if (current.DYNADOT_API_KEY && current.DYNADOT_SECRET_KEY) {
    console.log('[ensure-dynadot-env] OK — Dynadot keys present in .env')
    return
  }

  for (const backup of BACKUPS) {
    const keys = readKeys(backup)
    if (!keys.DYNADOT_API_KEY || !keys.DYNADOT_SECRET_KEY) continue

    let envText = ''
    try {
      envText = fs.readFileSync(ENV_PATH, 'utf8')
    } catch {
      // .env does not exist yet — it will be created
    }
    const kept = envText
      .split(/\r?\n/)
      .filter((l) => !/^\s*(DYNADOT_API_KEY|DYNADOT_SECRET_KEY)\s*=/.test(l))
      .join('\n')
      .replace(/\n+$/, '')
    const block = [
      '',
      '# === Dynadot API credentials (restored by scripts/ensure-dynadot-env.ts) ===',
      `DYNADOT_API_KEY=${keys.DYNADOT_API_KEY}`,
      `DYNADOT_SECRET_KEY=${keys.DYNADOT_SECRET_KEY}`,
      '',
    ].join('\n')
    fs.writeFileSync(ENV_PATH, (kept ? `${kept}\n` : '') + block, { mode: 0o600 })
    console.log(`[ensure-dynadot-env] Restored Dynadot keys to .env from ${backup}`)
    return
  }

  console.log(
    '[ensure-dynadot-env] Dynadot keys not set and no backup found — domain search/registration will run in demo mode. ' +
      'Add DYNADOT_API_KEY and DYNADOT_SECRET_KEY to .env to enable them.'
  )
}

main()
