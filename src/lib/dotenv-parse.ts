/**
 * Parse the contents of a .env file.
 *
 * Deliberately not pulling in the `dotenv` package: this runs on text a
 * customer pastes or uploads, and the failure mode that matters is a variable
 * silently coming out wrong (a quoted value keeping its quotes, an inline
 * comment ending up in a secret). Those cases are spelled out and tested here.
 *
 * Handles what a real .env contains:
 *   KEY=value                     plain
 *   export KEY=value              shell-style prefix
 *   KEY="value with spaces"       quotes stripped, escapes decoded
 *   KEY='raw $value'              single quotes stripped, contents literal
 *   KEY=value # trailing note      comment removed (unquoted values only)
 *   KEY=                          empty value, kept
 *   # comment / blank lines       ignored
 *   DATABASE_URL=postgres://u:p@h/db?x=1#frag   '#' inside a quoted value kept
 */
import { isValidEnvKey } from './safe-values'

export interface DotenvEntry {
  key: string
  value: string
}

export interface DotenvIssue {
  line: number
  text: string
  reason: string
}

export interface DotenvParseResult {
  entries: DotenvEntry[]
  /** Lines that looked like assignments but could not be used. */
  invalid: DotenvIssue[]
  /** Keys defined more than once; the last definition wins, as with dotenv. */
  duplicates: string[]
}

const MAX_VALUE_LENGTH = 32 * 1024

export function parseDotenv(text: string): DotenvParseResult {
  const seen = new Map<string, string>()
  const order: string[] = []
  const invalid: DotenvIssue[] = []
  const duplicates: string[] = []

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const body = line.replace(/^export\s+/, '')
    const eq = body.indexOf('=')
    if (eq < 1) {
      invalid.push({
        line: i + 1,
        text: line.slice(0, 80),
        reason: 'no "=" on this line',
      })
      continue
    }

    const key = body.slice(0, eq).trim()
    let value = body.slice(eq + 1).trim()

    const quote = value[0]
    if (
      (quote === '"' || quote === "'") &&
      value.length >= 2 &&
      value[value.length - 1] === quote
    ) {
      value = value.slice(1, -1)
      // Only double quotes interpret escapes, matching shell and dotenv.
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
      }
    } else {
      // Unquoted only: " #" starts a comment. Requiring the space keeps
      // fragments and fragment-like characters inside URLs and passwords.
      const hash = value.search(/\s#/)
      if (hash >= 0) value = value.slice(0, hash).trim()
    }

    const keyText = key.slice(0, 60)
    if (!isValidEnvKey(key)) {
      invalid.push({
        line: i + 1,
        text: keyText,
        reason: 'not a valid environment variable name',
      })
      continue
    }
    if (value.length > MAX_VALUE_LENGTH) {
      invalid.push({
        line: i + 1,
        text: key,
        reason: `value is longer than ${MAX_VALUE_LENGTH} characters`,
      })
      continue
    }

    if (seen.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key)
    } else {
      order.push(key)
    }
    seen.set(key, value)
  }

  return {
    entries: order.map((k) => ({ key: k, value: seen.get(k) as string })),
    invalid,
    duplicates,
  }
}
