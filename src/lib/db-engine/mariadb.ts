/**
 * MariaDB / MySQL driver
 * ======================
 *
 * Implements schema introspection, arbitrary-SQL execution, and typed row reads
 * on top of the docker-exec transport (`exec.ts`). Every function takes a
 * fully-resolved `TenantDbConnection`, so the caller has already proven
 * ownership and decrypted the tenant's non-root credentials.
 *
 * Two output strategies:
 *   - Ad-hoc SQL (the editor): `--batch` escaped-TSV, parsed leniently.
 *   - Structured reads (grid / introspection): `JSON_ARRAYAGG(JSON_OBJECT(...))`
 *     with `--raw --skip-column-names`, giving faithfully-typed values and
 *     unambiguous NULLs.
 */
import { execSql, execDump, parseBatchTsv, friendlyContainerError, type ExecResult } from './exec'
import type {
  TenantDbConnection,
  QueryResult,
  SqlCommand,
  SchemaTree,
  SchemaObjectSummary,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  RoutineInfo,
  TriggerInfo,
} from './types'

// ─── Identifier / literal quoting ──────────────────────────────────────────

/** Backtick-quote an identifier (table/column). Doubles internal backticks. */
export function quoteIdent(name: string): string {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

/** Single-quote a string literal for safe inline use (filters). */
export function quoteLiteral(value: string): string {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

// ─── Error + command parsing ───────────────────────────────────────────────

export interface ParsedSqlError {
  message: string
  code?: string
  sqlState?: string
}

/** Pull the clean `ERROR <code> (<state>): <msg>` line out of client stderr. */
export function parseSqlError(stderr: string): ParsedSqlError {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^ERROR\s+\d+/i.test(l))
  if (!line) {
    const cleaned = stderr.replace(/^-+$/gm, '').trim()
    return { message: cleaned || 'Query failed' }
  }
  const m = line.match(/^ERROR\s+(\d+)\s*\(([0-9A-Za-z]+)\)\s*(?:at line \d+)?:?\s*(.*)$/i)
  if (m) return { code: m[1], sqlState: m[2], message: m[3] || line }
  return { message: line }
}

/**
 * Why a client run failed, in words the customer can act on.
 *
 * Only the client's stderr used to be read, so a failure that printed
 * nothing there (docker reporting a missing container or binary on stdout, a
 * client crash) reached the customer as a bare "Query failed" — even for
 * SELECT 1 — with nothing in the logs. SQL errors keep their real message;
 * infrastructure failures get a plain explanation; the raw output is logged.
 */
export function execFailure(r: ExecResult): ParsedSqlError {
  if (/^ERROR\s+\d+/im.test(r.stderr)) return parseSqlError(r.stderr)
  if (r.timedOut) return { message: 'The database took too long to respond. Please try again.' }
  const raw = `${r.stderr}\n${r.stdout}`.trim()
  console.error('[db-engine] database client failed', { code: r.code, output: raw.slice(0, 500) })
  if (/executable file not found|no such container|is not running|is not up|cannot connect to the docker daemon|permission denied|oci runtime/i.test(raw)) {
    return { message: friendlyContainerError(raw, 'The database') }
  }
  if (/can't connect|connection refused|unknown database|access denied/i.test(raw)) {
    return { message: `The database could not be opened: ${raw.split('\n')[0].slice(0, 200)}` }
  }
  return {
    message: raw
      ? raw.split('\n')[0].slice(0, 200)
      : `The database client stopped without an error message (exit code ${r.code ?? 'unknown'}).`,
  }
}

/** Classify the leading verb of a statement (best-effort, comment-stripped). */
export function classifyCommand(sql: string): SqlCommand {
  const s = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/^\s+/, '')
    .toUpperCase()
  const verb = (s.match(/^[A-Z]+/) || ['OTHER'])[0]
  const known: SqlCommand[] = [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
    'TRUNCATE', 'SHOW', 'EXPLAIN', 'USE', 'SET', 'CALL',
  ]
  if (verb === 'WITH' || verb === 'DESC' || verb === 'DESCRIBE') return 'SELECT'
  return (known as string[]).includes(verb) ? (verb as SqlCommand) : 'OTHER'
}

const READ_COMMANDS = new Set<SqlCommand>(['SELECT', 'SHOW', 'EXPLAIN'])
export function isReadCommand(cmd: SqlCommand): boolean {
  return READ_COMMANDS.has(cmd)
}

// ─── JSON helper (typed structured reads) ──────────────────────────────────

/**
 * Run a query whose single row/column is a JSON document and parse it. Uses
 * `--raw --skip-column-names` so the JSON reaches us un-escaped and header-free.
 */
async function queryJson<T>(
  conn: TenantDbConnection,
  sql: string,
  timeoutMs = 20_000
): Promise<T> {
  const r = await execSql({
    engine: conn.engine,
    container: conn.container,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    sql,
    timeoutMs,
    clientArgs: ['--batch', '--raw', '--skip-column-names'],
  })
  if (!r.ok) {
    const e = execFailure(r)
    throw Object.assign(new Error(e.message), e)
  }
  const text = r.stdout.trim()
  if (!text || text === 'NULL') return JSON.parse('[]') as T
  return JSON.parse(text) as T
}

// ─── Arbitrary SQL execution (the editor) ──────────────────────────────────

export interface RunOptions {
  /** cap rows returned to the client for a SELECT-like statement */
  maxRows?: number
  timeoutMs?: number
}

/**
 * Execute a single ad-hoc statement and return a structured result. Read
 * statements come back with columns+rows; write statements come back with
 * affectedRows (via a same-session ROW_COUNT()).
 */
export async function runStatement(
  conn: TenantDbConnection,
  sql: string,
  opts: RunOptions = {}
): Promise<QueryResult> {
  const command = classifyCommand(sql)
  const maxRows = opts.maxRows ?? 1000
  const read = isReadCommand(command)

  // For writes, chain ROW_COUNT() in the SAME stdin session so it reflects the
  // statement we just ran. For reads, cap rows by wrapping when it's a bare
  // SELECT without an existing LIMIT (best-effort; complex SQL runs as-is).
  const trimmed = sql.trim().replace(/;\s*$/, '')
  let toRun = trimmed
  if (!read) toRun = `${trimmed};\nSELECT ROW_COUNT() AS \`__affected_rows\``

  const r = await execSql({
    engine: conn.engine,
    container: conn.container,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    sql: toRun,
    timeoutMs: opts.timeoutMs ?? 30_000,
    clientArgs: ['--batch'],
  })

  if (!r.ok) {
    const e = execFailure(r)
    throw Object.assign(new Error(e.message), { command, ...e })
  }

  const parsed = parseBatchTsv(r.stdout)

  if (!read) {
    // Last row/col is ROW_COUNT(); MySQL returns -1 for statements with no
    // affected-row concept — clamp to 0 for display.
    const raw = parsed.rows.at(-1)?.[0]
    const affected = Math.max(0, Number.parseInt(raw ?? '0', 10) || 0)
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: affected,
      durationMs: r.durationMs,
      command,
      note: `${affected} row${affected === 1 ? '' : 's'} affected`,
    }
  }

  const columns = parsed.columns.map((name) => ({ name }))
  const allRows = parsed.rows
  const truncated = allRows.length > maxRows
  const sliced = truncated ? allRows.slice(0, maxRows) : allRows
  const rows = sliced.map((cells) => {
    const obj: Record<string, unknown> = {}
    parsed.columns.forEach((c, i) => {
      obj[c] = cells[i] === 'NULL' ? null : cells[i]
    })
    return obj
  })

  return {
    columns,
    rows,
    rowCount: rows.length,
    durationMs: r.durationMs,
    command,
    truncated,
    note: `${allRows.length} row${allRows.length === 1 ? '' : 's'} in set${
      truncated ? ` (showing first ${maxRows})` : ''
    }`,
  }
}

// ─── Schema introspection ──────────────────────────────────────────────────

export async function getSchemaTree(conn: TenantDbConnection): Promise<SchemaTree> {
  const [objects, routines, triggers] = await Promise.all([
    queryJson<
      Array<{
        name: string
        kind: string
        rows: number | null
        sizeBytes: number | null
        engine: string | null
        comment: string | null
      }>
    >(
      conn,
      `SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
         'name', TABLE_NAME,
         'kind', IF(TABLE_TYPE='VIEW','view','table'),
         'rows', TABLE_ROWS,
         'sizeBytes', (DATA_LENGTH + INDEX_LENGTH),
         'engine', ENGINE,
         'comment', TABLE_COMMENT
       )), JSON_ARRAY())
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()`
    ),
    queryJson<Array<{ name: string; kind: string }>>(
      conn,
      `SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
         'name', ROUTINE_NAME, 'kind', ROUTINE_TYPE
       )), JSON_ARRAY())
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = DATABASE()`
    ),
    queryJson<Array<{ name: string; event: string; table: string; timing: string }>>(
      conn,
      `SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
         'name', TRIGGER_NAME, 'event', EVENT_MANIPULATION,
         'table', EVENT_OBJECT_TABLE, 'timing', ACTION_TIMING
       )), JSON_ARRAY())
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = DATABASE()`
    ),
  ])

  const summaries: SchemaObjectSummary[] = objects.map((o) => ({
    name: o.name,
    kind: o.kind === 'view' ? 'view' : 'table',
    rows: o.rows,
    sizeBytes: o.sizeBytes,
    engine: o.engine,
    comment: o.comment,
  }))

  return {
    database: conn.database,
    engine: conn.engine,
    tables: summaries.filter((s) => s.kind === 'table'),
    views: summaries.filter((s) => s.kind === 'view'),
    routines: routines.map((r) => ({
      name: r.name,
      kind: r.kind === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE',
    })) as RoutineInfo[],
    triggers: triggers as TriggerInfo[],
    collectedAt: new Date().toISOString(),
  }
}

export async function getColumns(
  conn: TenantDbConnection,
  table: string
): Promise<ColumnInfo[]> {
  return queryJson<ColumnInfo[]>(
    conn,
    `SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
       'name', COLUMN_NAME,
       'dataType', COLUMN_TYPE,
       'nullable', IF(IS_NULLABLE='YES', TRUE, FALSE),
       'key', COLUMN_KEY,
       'default', COLUMN_DEFAULT,
       'extra', EXTRA,
       'comment', COLUMN_COMMENT
     )), JSON_ARRAY())
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${quoteLiteral(table)}
     ORDER BY ORDINAL_POSITION`
  )
}

export async function getIndexes(
  conn: TenantDbConnection,
  table: string
): Promise<IndexInfo[]> {
  const rows = await queryJson<
    Array<{ name: string; column: string; nonUnique: number; type: string; seq: number }>
  >(
    conn,
    `SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
       'name', INDEX_NAME, 'column', COLUMN_NAME,
       'nonUnique', NON_UNIQUE, 'type', INDEX_TYPE, 'seq', SEQ_IN_INDEX
     )), JSON_ARRAY())
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${quoteLiteral(table)}
     ORDER BY INDEX_NAME, SEQ_IN_INDEX`
  )
  const byName = new Map<string, IndexInfo>()
  for (const r of rows) {
    let idx = byName.get(r.name)
    if (!idx) {
      idx = {
        name: r.name,
        columns: [],
        unique: r.nonUnique === 0,
        primary: r.name === 'PRIMARY',
        type: r.type,
      }
      byName.set(r.name, idx)
    }
    idx.columns.push(r.column)
  }
  return [...byName.values()]
}

export async function getForeignKeys(
  conn: TenantDbConnection,
  table: string
): Promise<ForeignKeyInfo[]> {
  return queryJson<ForeignKeyInfo[]>(
    conn,
    `SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
       'name', k.CONSTRAINT_NAME,
       'column', k.COLUMN_NAME,
       'refTable', k.REFERENCED_TABLE_NAME,
       'refColumn', k.REFERENCED_COLUMN_NAME,
       'onUpdate', r.UPDATE_RULE,
       'onDelete', r.DELETE_RULE
     )), JSON_ARRAY())
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r
       ON r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
      AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     WHERE k.TABLE_SCHEMA = DATABASE()
       AND k.TABLE_NAME = ${quoteLiteral(table)}
       AND k.REFERENCED_TABLE_NAME IS NOT NULL`
  )
}

// ─── Typed row reads (the data grid) ───────────────────────────────────────

export interface TableRowsOptions {
  limit?: number
  offset?: number
  orderBy?: string
  orderDir?: 'ASC' | 'DESC'
  /** simple equality/LIKE search across a chosen column */
  filterColumn?: string
  filterValue?: string
}

export interface TableRowsResult {
  columns: ColumnInfo[]
  rows: Array<Record<string, unknown>>
  total: number
  limit: number
  offset: number
}

/**
 * Read a page of rows from a table with proper types + NULLs (JSON path).
 * Table/column identifiers are validated against information_schema and
 * backtick-quoted, so a caller can't smuggle SQL through them.
 */
export async function getTableRows(
  conn: TenantDbConnection,
  table: string,
  opts: TableRowsOptions = {}
): Promise<TableRowsResult> {
  const columns = await getColumns(conn, table)
  if (columns.length === 0) {
    throw new Error(`Table not found or has no columns: ${table}`)
  }
  const colNames = new Set(columns.map((c) => c.name))
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  // WHERE (optional, validated column only)
  let where = ''
  if (opts.filterColumn && colNames.has(opts.filterColumn) && opts.filterValue != null) {
    where = ` WHERE ${quoteIdent(opts.filterColumn)} LIKE ${quoteLiteral(
      `%${opts.filterValue}%`
    )}`
  }

  // ORDER BY (optional, validated column only)
  let orderBy = ''
  if (opts.orderBy && colNames.has(opts.orderBy)) {
    const dir = opts.orderDir === 'DESC' ? 'DESC' : 'ASC'
    orderBy = ` ORDER BY ${quoteIdent(opts.orderBy)} ${dir}`
  }

  const jsonPairs = columns
    .map((c) => `${quoteLiteral(c.name)}, ${quoteIdent(c.name)}`)
    .join(', ')
  const tableRef = quoteIdent(table)

  const [rows, totalRow] = await Promise.all([
    queryJson<Array<Record<string, unknown>>>(
      conn,
      `SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(${jsonPairs})), JSON_ARRAY())
       FROM (
         SELECT * FROM ${tableRef}${where}${orderBy}
         LIMIT ${limit} OFFSET ${offset}
       ) AS _page`
    ),
    queryJson<Array<{ n: number }>>(
      conn,
      `SELECT JSON_ARRAY(JSON_OBJECT('n', (SELECT COUNT(*) FROM ${tableRef}${where})))`
    ),
  ])

  return {
    columns,
    rows,
    total: totalRow[0]?.n ?? rows.length,
    limit,
    offset,
  }
}

// ─── Dashboard stats ───────────────────────────────────────────────────────

export interface DatabaseStats {
  database: string
  tableCount: number
  viewCount: number
  totalRows: number
  sizeBytes: number
}

export async function getDatabaseStats(
  conn: TenantDbConnection
): Promise<DatabaseStats> {
  const rows = await queryJson<
    Array<{ tables: number; views: number; totalRows: number; sizeBytes: number }>
  >(
    conn,
    `SELECT JSON_ARRAY(JSON_OBJECT(
       'tables', SUM(TABLE_TYPE='BASE TABLE'),
       'views',  SUM(TABLE_TYPE='VIEW'),
       'totalRows', COALESCE(SUM(TABLE_ROWS),0),
       'sizeBytes', COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH),0)
     ))
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()`
  )
  const s = rows[0] ?? { tables: 0, views: 0, totalRows: 0, sizeBytes: 0 }
  return {
    database: conn.database,
    tableCount: Number(s.tables) || 0,
    viewCount: Number(s.views) || 0,
    totalRows: Number(s.totalRows) || 0,
    sizeBytes: Number(s.sizeBytes) || 0,
  }
}

// ─── Row mutations (Data Grid write ops) ───────────────────────────────────

export interface RowMutationResult {
  affectedRows: number
  durationMs: number
}

/** Primary-key column names for a table (empty when the table has no PK). */
export async function getPrimaryKey(
  conn: TenantDbConnection,
  table: string
): Promise<string[]> {
  const cols = await getColumns(conn, table)
  return cols.filter((c) => c.key === 'PRI').map((c) => c.name)
}

/** Render a JS value as a SQL literal (or the NULL keyword). */
function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  return quoteLiteral(String(v))
}

/**
 * WHERE clause matching exactly one row by its primary key. Edits/deletes are
 * refused for PK-less tables so we can never fan out across multiple rows.
 */
function whereByKey(pk: string[], key: Record<string, unknown>): string {
  if (pk.length === 0) {
    throw new Error(
      'This table has no primary key, so row edit/delete is disabled for safety.'
    )
  }
  return pk
    .map((c) =>
      key[c] === null || key[c] === undefined
        ? `${quoteIdent(c)} IS NULL`
        : `${quoteIdent(c)} = ${sqlValue(key[c])}`
    )
    .join(' AND ')
}

/** UPDATE a single row identified by its primary key. */
export async function updateRow(
  conn: TenantDbConnection,
  table: string,
  key: Record<string, unknown>,
  changes: Record<string, unknown>
): Promise<RowMutationResult> {
  const cols = await getColumns(conn, table)
  const valid = new Set(cols.map((c) => c.name))
  const pk = cols.filter((c) => c.key === 'PRI').map((c) => c.name)
  const sets = Object.entries(changes)
    .filter(([c]) => valid.has(c))
    .map(([c, v]) => `${quoteIdent(c)} = ${sqlValue(v)}`)
  if (sets.length === 0) return { affectedRows: 0, durationMs: 0 }
  const sql = `UPDATE ${quoteIdent(table)} SET ${sets.join(', ')} WHERE ${whereByKey(
    pk,
    key
  )} LIMIT 1`
  const r = await runStatement(conn, sql)
  return { affectedRows: r.affectedRows ?? 0, durationMs: r.durationMs }
}

/** INSERT a single row from a { column: value } map. */
export async function insertRow(
  conn: TenantDbConnection,
  table: string,
  values: Record<string, unknown>
): Promise<RowMutationResult> {
  const cols = await getColumns(conn, table)
  const valid = new Set(cols.map((c) => c.name))
  const entries = Object.entries(values).filter(([c]) => valid.has(c))
  if (entries.length === 0) throw new Error('No valid columns provided to insert')
  const colList = entries.map(([c]) => quoteIdent(c)).join(', ')
  const valList = entries.map(([, v]) => sqlValue(v)).join(', ')
  const sql = `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${valList})`
  const r = await runStatement(conn, sql)
  return { affectedRows: r.affectedRows ?? 0, durationMs: r.durationMs }
}

/** DELETE a single row identified by its primary key. */
export async function deleteRow(
  conn: TenantDbConnection,
  table: string,
  key: Record<string, unknown>
): Promise<RowMutationResult> {
  const pk = await getPrimaryKey(conn, table)
  const sql = `DELETE FROM ${quoteIdent(table)} WHERE ${whereByKey(pk, key)} LIMIT 1`
  const r = await runStatement(conn, sql)
  return { affectedRows: r.affectedRows ?? 0, durationMs: r.durationMs }
}

// ─── Export (SQL dump) ─────────────────────────────────────────────────────

export type DumpMode = 'full' | 'structure' | 'data'

/**
 * Produce a `mariadb-dump` of the tenant database. `structure` omits rows,
 * `data` omits CREATE statements, `full` includes both.
 */
export async function dumpDatabase(
  conn: TenantDbConnection,
  mode: DumpMode = 'full'
): Promise<{ sql: string; durationMs: number }> {
  const extraArgs =
    mode === 'structure' ? ['--no-data'] : mode === 'data' ? ['--no-create-info'] : []
  const r = await execDump({
    container: conn.container,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    extraArgs,
  })
  if (!r.ok) {
    const e = execFailure(r)
    throw Object.assign(new Error(e.message || 'Export failed'), e)
  }
  return { sql: r.stdout, durationMs: r.durationMs }
}

// ─── Import (run a .sql script) ────────────────────────────────────────────

/**
 * Execute an uploaded SQL script against the tenant database. The whole script
 * is fed on stdin to the mariadb client (multi-statement), running as the
 * non-root tenant user — so it can only affect this tenant's database. Returns
 * a structured error (not a throw) when a statement fails.
 */
export async function importSql(
  conn: TenantDbConnection,
  sql: string
): Promise<{ ok: boolean; error?: string; durationMs: number }> {
  const r = await execSql({
    engine: conn.engine,
    container: conn.container,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    sql,
    timeoutMs: 300_000,
    clientArgs: ['--batch'],
  })
  if (!r.ok) {
    const e = execFailure(r)
    return { ok: false, error: e.message || r.stderr.slice(0, 300), durationMs: r.durationMs }
  }
  return { ok: true, durationMs: r.durationMs }
}

// ─── Table operations (DDL) ────────────────────────────────────────────────

export type TableOp = 'truncate' | 'drop' | 'rename' | 'optimize' | 'analyze'

const SAFE_IDENT = /^[A-Za-z0-9_$]{1,64}$/

/** Run a maintenance / DDL operation on a single table. */
export async function tableOperation(
  conn: TenantDbConnection,
  table: string,
  op: TableOp,
  newName?: string
): Promise<{ ok: boolean; message: string; durationMs: number }> {
  let sql: string
  switch (op) {
    case 'truncate':
      sql = `TRUNCATE TABLE ${quoteIdent(table)}`
      break
    case 'drop':
      sql = `DROP TABLE ${quoteIdent(table)}`
      break
    case 'optimize':
      sql = `OPTIMIZE TABLE ${quoteIdent(table)}`
      break
    case 'analyze':
      sql = `ANALYZE TABLE ${quoteIdent(table)}`
      break
    case 'rename':
      if (!newName || !SAFE_IDENT.test(newName)) {
        throw new Error('Invalid new table name (letters, digits, _ and $ only)')
      }
      sql = `RENAME TABLE ${quoteIdent(table)} TO ${quoteIdent(newName)}`
      break
    default:
      throw new Error('Unknown table operation')
  }
  const r = await runStatement(conn, sql)
  return { ok: true, message: r.note || 'Done', durationMs: r.durationMs }
}
