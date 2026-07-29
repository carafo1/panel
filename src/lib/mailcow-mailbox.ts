/**
 * Per-mailbox features: auto-reply, sieve filters, app passwords.
 *
 * Mailcow has **no out-of-office endpoint** — `get/oof/…` and `add/oof/…`
 * both answer "route not found". Auto-reply is therefore a sieve `vacation`
 * script, which is what Mailcow's own UI generates. This module owns that
 * script so the customer edits a form instead of writing sieve: the managed
 * script is tagged by its description and replaced wholesale on each save.
 *
 * As everywhere in the Mailcow API, the read endpoints do not mirror the write
 * ones — app passwords list at `/get/app-passwd/all/{mailbox}` and come back
 * `{}` (a silent empty, not an error) at any other path. See
 * [[mailcow-api-quirks]].
 */
import { mailcowRequest, isMailcowConfigured } from '@/lib/mailcow-manage'

/** Description that marks the sieve script this module manages. */
export const AUTOREPLY_DESC = 'Apsamo auto-reply'

/** Prefix marking a filter this module generated from a rule form. */
export const RULE_PREFIX = 'Apsamo rule: '

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SieveFilter {
  id: number
  username: string
  filterType: 'prefilter' | 'postfilter'
  description: string
  script: string
  active: boolean
}

export interface AutoReply {
  enabled: boolean
  subject: string
  message: string
  /** ISO date (YYYY-MM-DD) or null for "from now". */
  startDate: string | null
  /** ISO date (YYYY-MM-DD) or null for "until turned off". */
  endDate: string | null
  /** Days before the same sender gets another reply. */
  intervalDays: number
}

export interface AppPassword {
  id: number
  name: string
  mailbox: string
  domain: string
  active: boolean
  createdAt?: string
}

interface RawFilter {
  id?: number
  username?: string
  filter_type?: string
  script_desc?: string
  script_data?: string
  active?: number | string
}

interface RawAppPassword {
  id?: number
  name?: string
  mailbox?: string
  domain?: string
  active?: number | string
  created?: string
}

function truthy(v: unknown): boolean {
  return v === 1 || v === '1' || v === true
}

// ─── Sieve filters ─────────────────────────────────────────────────────────

function mapFilter(r: RawFilter): SieveFilter {
  return {
    id: Number(r.id || 0),
    username: String(r.username || ''),
    filterType: r.filter_type === 'prefilter' ? 'prefilter' : 'postfilter',
    description: String(r.script_desc || ''),
    script: String(r.script_data || ''),
    active: truthy(r.active),
  }
}

/**
 * Every sieve filter belonging to one mailbox.
 *
 * Filtered here rather than trusting `/get/filters/{mailbox}` to scope: the
 * server-wide `/all` form is the one confirmed to return data, and the same
 * app-side filtering is what the rest of the panel does for Mailcow reads.
 */
export async function listFilters(mailbox: string): Promise<SieveFilter[]> {
  if (!isMailcowConfigured()) return []
  const raw = await mailcowRequest<RawFilter[]>('/get/filters/all').catch(() => [])
  const list = Array.isArray(raw) ? raw : []
  const target = mailbox.toLowerCase()
  return list
    .map(mapFilter)
    .filter((f) => f.username.toLowerCase() === target)
}

export async function createFilter(opts: {
  mailbox: string
  description: string
  script: string
  filterType?: 'prefilter' | 'postfilter'
  active?: boolean
}): Promise<{ success: boolean; error?: string }> {
  return mailcowEnvelope('/add/filter', {
    username: opts.mailbox,
    script_desc: opts.description,
    script_data: opts.script,
    filter_type: opts.filterType || 'postfilter',
    active: opts.active === false ? '0' : '1',
  })
}

export async function updateFilter(
  id: number,
  attr: {
    description?: string
    script?: string
    filterType?: 'prefilter' | 'postfilter'
    active?: boolean
  }
): Promise<{ success: boolean; error?: string }> {
  const body: Record<string, unknown> = {}
  if (attr.description !== undefined) body.script_desc = attr.description
  if (attr.script !== undefined) body.script_data = attr.script
  if (attr.filterType !== undefined) body.filter_type = attr.filterType
  if (attr.active !== undefined) body.active = attr.active ? '1' : '0'
  return mailcowEnvelope('/edit/filter', { items: [String(id)], attr: body }, true)
}

export async function deleteFilter(
  id: number
): Promise<{ success: boolean; error?: string }> {
  // Delete endpoints take a bare array of identifiers.
  return mailcowEnvelope('/delete/filter', [String(id)], true)
}

// ─── Auto-reply (sieve vacation) ───────────────────────────────────────────

function escapeSieve(value: string): string {
  // Sieve string literals escape only backslash and double quote.
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Render a message as a sieve string.
 *
 * A quoted sieve string cannot contain a raw newline, so a multi-line
 * auto-reply has to use the multi-line form (`text:` … `.`). Inside it a line
 * consisting only of "." would terminate the block early, so such lines are
 * dot-stuffed — the same rule as SMTP DATA.
 */
function sieveText(value: string): string {
  const normalised = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalised.includes('\n')) return `"${escapeSieve(normalised)}"`
  const stuffed = normalised
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\n')
  return `text:\n${stuffed}\n.`
}

/**
 * Build the vacation script.
 *
 * A date range needs the "date" extension and a `currentdate` guard — plain
 * `vacation` has no notion of a start or end. `:addresses` stops the reply
 * firing for mail that merely mentions the mailbox, and Dovecot suppresses
 * replies to bulk/automated senders on its own.
 */
export function buildAutoReplyScript(mailbox: string, reply: AutoReply): string {
  const needsDate = Boolean(reply.startDate || reply.endDate)
  const requires = needsDate ? '["vacation", "date", "relational"]' : '["vacation"]'

  const message = sieveText(reply.message)
  const head = `vacation :days ${Math.max(1, reply.intervalDays)} :subject "${escapeSieve(
    reply.subject
  )}" :addresses ["${escapeSieve(mailbox)}"] ${message}`
  // A multi-line string ends on a line containing only "." — the terminating
  // semicolon has to go on the line AFTER it, not appended to the dot.
  const body = message.startsWith('text:') ? `${head}\n;` : `${head};`

  if (!needsDate) return `require ${requires};\n${body}\n`

  const tests: string[] = []
  if (reply.startDate) {
    tests.push(`currentdate :value "ge" "date" "${escapeSieve(reply.startDate)}"`)
  }
  if (reply.endDate) {
    tests.push(`currentdate :value "le" "date" "${escapeSieve(reply.endDate)}"`)
  }
  const condition = tests.length > 1 ? `allof(${tests.join(', ')})` : tests[0]
  return `require ${requires};\nif ${condition} {\n  ${body}\n}\n`
}

/** The managed auto-reply for a mailbox, or a disabled default. */
export async function getAutoReply(mailbox: string): Promise<AutoReply & { id?: number }> {
  const filters = await listFilters(mailbox)
  const managed = filters.find((f) => f.description === AUTOREPLY_DESC)
  if (!managed) {
    return {
      enabled: false,
      subject: 'Out of office',
      message: '',
      startDate: null,
      endDate: null,
      intervalDays: 1,
    }
  }

  // Read the form values back out of the script we generated.
  const subject = /:subject\s+"((?:[^"\\]|\\.)*)"/.exec(managed.script)?.[1] || 'Out of office'
  const days = Number(/:days\s+(\d+)/.exec(managed.script)?.[1] || 1)
  const dates = [...managed.script.matchAll(/currentdate :value "(ge|le)" "date" "([^"]+)"/g)]
  const unescape = (s: string) => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\')

  // The message is either a multi-line `text:` block terminated by a lone "."
  // (with dot-stuffing to undo), or the last quoted string on the vacation
  // line. Try the multi-line form first — a quoted-string match would
  // otherwise pick up the :addresses argument.
  let message: string
  const multiline = /\btext:\r?\n([\s\S]*?)\r?\n\.\s*$/m.exec(managed.script)
  if (multiline) {
    message = multiline[1]
      .split('\n')
      .map((line) => (line.startsWith('..') ? line.slice(1) : line))
      .join('\n')
  } else {
    const quoted = /\]\s*"((?:[^"\\]|\\.)*)"\s*;/.exec(managed.script)
    message = unescape(quoted?.[1] || '')
  }

  return {
    id: managed.id,
    enabled: managed.active,
    subject: unescape(subject),
    message,
    startDate: dates.find((d) => d[1] === 'ge')?.[2] || null,
    endDate: dates.find((d) => d[1] === 'le')?.[2] || null,
    intervalDays: days || 1,
  }
}

/**
 * Save the auto-reply. Replaces the managed script wholesale rather than
 * editing it, so a half-written script can never be left behind.
 */
export async function setAutoReply(
  mailbox: string,
  reply: AutoReply
): Promise<{ success: boolean; error?: string }> {
  const existing = await getAutoReply(mailbox)

  // Turning it off with nothing configured is a no-op, not an error.
  if (!reply.enabled && !existing.id) return { success: true }

  if (existing.id) {
    const del = await deleteFilter(existing.id)
    if (!del.success) return del
  }
  if (!reply.enabled) return { success: true }

  return createFilter({
    mailbox,
    description: AUTOREPLY_DESC,
    script: buildAutoReplyScript(mailbox, reply),
    filterType: 'postfilter',
    active: true,
  })
}

// ─── Mail rules (sieve, generated from a form) ─────────────────────────────

export type RuleField = 'from' | 'to' | 'subject'
export type RuleMatch = 'contains' | 'is'
export type RuleAction = 'fileinto' | 'discard' | 'markread' | 'flag'

export interface MailRule {
  /** Mailcow filter id; absent for a rule not yet saved. */
  id?: number
  name: string
  field: RuleField
  match: RuleMatch
  value: string
  action: RuleAction
  /** Destination folder, required when action is `fileinto`. */
  folder?: string
  /** Stop processing later rules once this one matches. */
  stop: boolean
  active: boolean
}

const HEADER_FOR: Record<RuleField, string> = {
  from: 'from',
  to: 'to',
  subject: 'subject',
}

/**
 * Turn a rule into sieve.
 *
 * Customers should never write sieve — an invalid script is rejected by
 * Mailcow with a message that means nothing to them, and a subtly wrong one
 * silently misfiles their mail. So the form is the source of truth and this is
 * the only place a rule script is produced.
 */
export function buildRuleScript(rule: MailRule): string {
  const requires: string[] = []
  if (rule.action === 'fileinto') requires.push('"fileinto"', '"mailbox"')
  if (rule.action === 'markread' || rule.action === 'flag') requires.push('"imap4flags"')

  const test = `header :${rule.match === 'is' ? 'is' : 'contains'} "${HEADER_FOR[rule.field]}" "${escapeSieve(
    rule.value
  )}"`

  const body: string[] = []
  switch (rule.action) {
    case 'fileinto':
      // :create makes the folder if the customer named one that does not exist
      // yet, rather than silently dropping the rule on the floor.
      body.push(`fileinto :create "${escapeSieve(rule.folder || 'INBOX')}";`)
      break
    case 'discard':
      body.push('discard;')
      break
    case 'markread':
      body.push('addflag "\\\\Seen";')
      break
    case 'flag':
      body.push('addflag "\\\\Flagged";')
      break
  }
  if (rule.stop) body.push('stop;')

  const head = requires.length ? `require [${[...new Set(requires)].join(', ')}];\n` : ''
  return `${head}if ${test} {\n  ${body.join('\n  ')}\n}\n`
}

/** Read a rule back out of the script this module generated. */
function parseRuleScript(f: SieveFilter): MailRule | null {
  if (!f.description.startsWith(RULE_PREFIX)) return null

  const m = /header :(is|contains) "(from|to|subject)" "((?:[^"\\]|\\.)*)"/.exec(f.script)
  if (!m) return null
  const unescape = (s: string) => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\')

  let action: RuleAction = 'fileinto'
  let folder: string | undefined
  const fileinto = /fileinto(?: :create)? "((?:[^"\\]|\\.)*)"/.exec(f.script)
  if (fileinto) {
    action = 'fileinto'
    folder = unescape(fileinto[1])
  } else if (/\bdiscard\s*;/.test(f.script)) action = 'discard'
  else if (/addflag "\\\\Seen"/.test(f.script)) action = 'markread'
  else if (/addflag "\\\\Flagged"/.test(f.script)) action = 'flag'

  return {
    id: f.id,
    name: f.description.slice(RULE_PREFIX.length),
    match: m[1] === 'is' ? 'is' : 'contains',
    field: m[2] as RuleField,
    value: unescape(m[3]),
    action,
    folder,
    stop: /\bstop\s*;/.test(f.script),
    active: f.active,
  }
}

/**
 * The rules for a mailbox.
 *
 * Only scripts this module generated are returned. A filter written by hand in
 * Mailcow is deliberately left out — it cannot be represented in the form, and
 * showing it would invite a save that silently rewrote it.
 */
export async function listRules(mailbox: string): Promise<MailRule[]> {
  const filters = await listFilters(mailbox)
  return filters
    .map(parseRuleScript)
    .filter((r): r is MailRule => r !== null)
}

export async function createRule(
  mailbox: string,
  rule: MailRule
): Promise<{ success: boolean; error?: string }> {
  return createFilter({
    mailbox,
    description: `${RULE_PREFIX}${rule.name}`,
    script: buildRuleScript(rule),
    filterType: 'prefilter',
    active: rule.active,
  })
}

export async function updateRule(
  id: number,
  rule: MailRule
): Promise<{ success: boolean; error?: string }> {
  return updateFilter(id, {
    description: `${RULE_PREFIX}${rule.name}`,
    script: buildRuleScript(rule),
    active: rule.active,
  })
}

/** Delete a rule, refusing anything that is not a managed rule. */
export async function deleteRule(
  mailbox: string,
  id: number
): Promise<{ success: boolean; error?: string }> {
  const mine = await listRules(mailbox)
  if (!mine.some((r) => r.id === id)) {
    return { success: false, error: 'Rule not found' }
  }
  return deleteFilter(id)
}

// ─── App passwords ─────────────────────────────────────────────────────────

/**
 * App passwords for one mailbox.
 *
 * MUST be `/get/app-passwd/all/{mailbox}`. Every other path — including the
 * server-wide `/get/app-passwd/all` — returns `{}` rather than an error.
 */
export async function listAppPasswords(mailbox: string): Promise<AppPassword[]> {
  if (!isMailcowConfigured()) return []
  const raw = await mailcowRequest<RawAppPassword[]>(
    `/get/app-passwd/all/${encodeURIComponent(mailbox)}`
  ).catch(() => [])
  const list = Array.isArray(raw) ? raw : []
  return list.map((r) => ({
    id: Number(r.id || 0),
    name: String(r.name || ''),
    mailbox: String(r.mailbox || mailbox),
    domain: String(r.domain || ''),
    active: truthy(r.active),
    createdAt: r.created,
  }))
}

/**
 * Create an app password. The plaintext is never stored by us — it is shown
 * to the customer once and only the hash lives in Mailcow.
 */
export async function createAppPassword(opts: {
  mailbox: string
  name: string
  password: string
  protocols?: string[]
}): Promise<{ success: boolean; error?: string }> {
  return mailcowEnvelope('/add/app-passwd', {
    username: opts.mailbox,
    app_name: opts.name,
    app_passwd: opts.password,
    app_passwd2: opts.password,
    active: '1',
    protocols: opts.protocols || [
      'imap_access',
      'smtp_access',
      'dav_access',
      'eas_access',
    ],
  })
}

export async function deleteAppPassword(
  id: number
): Promise<{ success: boolean; error?: string }> {
  return mailcowEnvelope('/delete/app-passwd', [String(id)], true)
}

// ─── Envelope helper ───────────────────────────────────────────────────────

interface Envelope {
  type?: string
  msg?: unknown
}

/**
 * POST a mutation and read Mailcow's `{ type, msg }` envelope.
 * `rawBody` sends the body exactly as given — needed because delete endpoints
 * take a bare array while add endpoints take an object.
 */
async function mailcowEnvelope(
  path: string,
  body: unknown,
  rawBody = false
): Promise<{ success: boolean; error?: string }> {
  if (!isMailcowConfigured()) {
    console.log('[mailcow-mailbox] DEMO MODE:', path)
    return { success: true }
  }
  try {
    void rawBody // body is already in the exact shape each endpoint expects
    const res = await mailcowRequest<Envelope | Envelope[]>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const arr = Array.isArray(res) ? res : [res]
    const ok = arr.some((e) => String(e?.type || '').toLowerCase() === 'success')
    if (ok) return { success: true }
    const msg = arr
      .map((e) => {
        const m = e?.msg
        if (Array.isArray(m)) return m.join(', ')
        if (typeof m === 'string') return m
        if (m && typeof m === 'object') return JSON.stringify(m)
        return ''
      })
      .filter(Boolean)
      .join('; ')
    return { success: false, error: msg || 'Mailcow request failed' }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
