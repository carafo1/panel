/**
 * PostgreSQL driver
 * =================
 *
 * Mirrors the MariaDB driver's interface so Database Studio works against
 * either engine. SQL runs through `psql` inside the tenant's own container via
 * `docker exec`, authenticated as the tenant's NON-superuser role — the same
 * transport and isolation model as MySQL/MariaDB (see `exec.ts`).
 *
 * Two output strategies, matching the MariaDB driver:
 *   - Ad-hoc SQL (the editor): unaligned output with a header row, parsed as
 *     TSV, with psql's command tag ("UPDATE 3") detected for writes.
 *   - Structured reads (grid / introspection): `json_agg`, which gives properly
 *     typed values and unambiguous NULLs.
 */
import { execSql, execDump } from './exec'
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

// ─── Quoting ───────────────────────────────────────────────────────────────

/** Double-quote an identifier (Postgres is case-sensitive when quoted). */
export function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

/** Single-quote a string literal. */
export function quoteLiteral(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

// ─── Errors + command classification ───────────────────────────────────────

export interface ParsedSqlError {
  message: string
  code?: string
}

/** Pull psql's `ERROR:  …` line out of stderr. */
export function parseSqlError(stderr: string): ParsedSqlError {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^(ERROR|FATAL):/i.test(l))
  if (!line) {
    return { message: stderr.trim().split('\n')[0] || 'Query failed' }
  }
  return { message: line.replace(/^(ERROR|FATAL):\s*/i, '') }
}

export function classifyCommand(sql: string): SqlCommand {
  const s = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/^\s+/, '')
    .toUpperCase()
  const verb = (s.match(/^[A-Z]+/) || ['OTHER'])[0]
  const known: SqlCommand[] = [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
    'TRUNCATE', 'SHOW', 'EXPLAIN', 'SET', 'CALL',
  ]
  if (verb === 'WITH' || verb === 'TABLE' || verb === 'VALUES') return 'SELECT'
  return (known as string[]).includes(verb) ? (verb as SqlCommand) : 'OTHER'
}

/** psql prints a command tag rather than a result set for writes/DDL. */
const COMMAND_TAG =
  /^(INSERT\s+\d+\s+(\d+)|UPDATE\s+(\d+)|DELETE\s+(\d+)|SELECT\s+(\d+)|COPY\s+(\d+)|MERGE\s+(\d+)|CREATE\b.*|DROP\b.*|ALTER\b.*|TRUNCATE\b.*|GRANT\b.*|REVOKE\b.*|COMMENT\b.*|SET\b.*|BEGIN|COMMIT|ROLLBACK|VACUUM|ANALYZE|REINDEX|DO)$/i

// ─── Low-level psql helpers ────────────────────────────────────────────────

async function psql(
  conn: TenantDbConnection,
  sql: string,
  clientArgs: string[],
  timeoutMs = 30_000
) {
  return execSql({
    engine: 'postgres',
    container: conn.container,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    sql,
    timeoutMs,
    clientArgs,
  })
}

/**
 * Run a query whose single value is a JSON document and parse it.
 * `-tAX` = tuples only, unaligned, ignore ~/.psqlrc.
 */
async function queryJson<T>(
  conn: TenantDbConnection,
  sql: string,
  timeoutMs = 20_000
): Promise<T> {
  const r = await psql(conn, sql, ['-tAX'], timeoutMs)
  if (!r.ok) {
    const e = parseSqlError(r.stderr)
    throw Object.assign(new Error(e.message), e)
  }
  const text = r.stdout.trim()
  if (!text) return JSON.parse('[]') as T
  return JSON.parse(text) as T
}

// ─── Ad-hoc SQL (the editor) ───────────────────────────────────────────────

export interface RunOptions {
  maxRows?: number
  timeoutMs?: number
}

export async function runStatement(
  conn: TenantDbConnection,
  sql: string,
  opts: RunOptions = {}
): Promise<QueryResult> {
  const command = classifyCommand(sql)
  const maxRows = opts.maxRows ?? 1000

  // -A unaligned, -F tab, footer off: a header row then data rows, or a bare
  // command tag for statements that return no rows.
  //
  // ON_ERROR_STOP is essential, not cosmetic: psql exits 0 even when a
  // statement fails, so without it a syntax error or a missing table would come
  // back as a successful "statement executed" with no rows.
  const r = await psql(
    conn,
    sql.trim().replace(/;\s*$/, ''),
    ['-AX', '-F', '\t', '--pset', 'footer=off', '-v', 'ON_ERROR_STOP=1'],
    opts.timeoutMs ?? 30_000
  )

  if (!r.ok) {
    const e = parseSqlError(r.stderr)
    throw Object.assign(new Error(e.message), { command, ...e })
  }

  const lines = r.stdout.replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  // Write / DDL: psql emits just a command tag.
  if (lines.length <= 1 && (lines.length === 0 || COMMAND_TAG.test(lines[0].trim()))) {
    const tag = lines[0]?.trim() ?? ''
    const m = tag.match(/(\d+)\s*$/)
    const affected = m ? Number(m[1]) : 0
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: affected,
      durationMs: r.durationMs,
      command,
      note: tag || 'Statement executed',
    }
  }

  const header = lines[0].split('\t')
  const all = lines.slice(1).map((l) => l.split('\t'))
  const truncated = all.length > maxRows
  const sliced = truncated ? all.slice(0, maxRows) : all
  const rows = sliced.map((cells) => {
    const obj: Record<string, unknown> = {}
    header.forEach((c, i) => {
      // psql renders SQL NULL as an empty field in unaligned mode.
      obj[c] = cells[i] === undefined || cells[i] === '' ? null : cells[i]
    })
    return obj
  })

  return {
    columns: header.map((name) => ({ name })),
    rows,
    rowCount: rows.length,
    durationMs: r.durationMs,
    command,
    truncated,
    note: `${all.length} row${all.length === 1 ? '' : 's'}${
      truncated ? ` (showing first ${maxRows})` : ''
    }`,
  }
}

// ─── Schema introspection ──────────────────────────────────────────────────

/**
 * Only user schemas are exposed: pg_catalog, information_schema and the
 * pg_toast/pg_temp namespaces are internal and never the tenant's data.
 */
const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`

export async function getSchemaTree(conn: TenantDbConnection): Promise<SchemaTree> {
  const [objects, routines, triggers] = await Promise.all([
    queryJson<
      Array<{
        name: string
        kind: string
        rows: number | null
        sizeBytes: number | null
        schema: string
      }>
    >(
      conn,
      `SELECT COALESCE(json_agg(t), '[]') FROM (
         SELECT c.relname AS name,
                CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind,
                CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows,
                pg_total_relation_size(c.oid) AS "sizeBytes",
                n.nspname AS schema
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','p','v','m') AND ${USER_SCHEMAS}
         ORDER BY c.relname
       ) t`
    ),
    queryJson<Array<{ name: string; kind: string }>>(
      conn,
      `SELECT COALESCE(json_agg(t), '[]') FROM (
         SELECT p.proname AS name,
                CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS kind
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${USER_SCHEMAS}
         ORDER BY p.proname
       ) t`
    ),
    queryJson<Array<{ name: string; event: string; table: string; timing: string }>>(
      conn,
      `SELECT COALESCE(json_agg(t), '[]') FROM (
         SELECT tg.tgname AS name,
                CASE WHEN (tg.tgtype & 4) > 0 THEN 'INSERT'
                     WHEN (tg.tgtype & 8) > 0 THEN 'DELETE'
                     WHEN (tg.tgtype & 16) > 0 THEN 'UPDATE' ELSE 'TRUNCATE' END AS event,
                c.relname AS "table",
                CASE WHEN (tg.tgtype & 2) > 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing
         FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT tg.tgisinternal AND ${USER_SCHEMAS}
         ORDER BY tg.tgname
       ) t`
    ),
  ])

  const summaries: SchemaObjectSummary[] = objects.map((o) => ({
    name: o.name,
    kind: o.kind === 'view' ? 'view' : 'table',
    rows: o.rows === null ? null : Number(o.rows),
    sizeBytes: o.sizeBytes === null ? null : Number(o.sizeBytes),
    engine: o.schema,
    comment: null,
  }))

  return {
    database: conn.database,
    engine: 'postgres',
    tables: summaries.filter((s) => s.kind === 'table'),
    views: summaries.filter((s) => s.kind === 'view'),
    routines: routines as RoutineInfo[],
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
    `SELECT COALESCE(json_agg(t), '[]') FROM (
       SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS "dataType",
              NOT a.attnotnull AS nullable,
              CASE WHEN EXISTS (
                     SELECT 1 FROM pg_index i
                     WHERE i.indrelid = a.attrelid AND a.attnum = ANY(i.indkey) AND i.indisprimary
                   ) THEN 'PRI'
                   WHEN EXISTS (
                     SELECT 1 FROM pg_index i
                     WHERE i.indrelid = a.attrelid AND a.attnum = ANY(i.indkey) AND i.indisunique
                   ) THEN 'UNI'
                   ELSE '' END AS key,
              pg_get_expr(d.adbin, d.adrelid) AS "default",
              CASE WHEN a.attidentity <> '' THEN 'identity'
                   WHEN pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%' THEN 'auto_increment'
                   ELSE '' END AS extra,
              COALESCE(col_description(a.attrelid, a.attnum), '') AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE c.relname = ${quoteLiteral(table)} AND a.attnum > 0 AND NOT a.attisdropped
         AND ${USER_SCHEMAS}
       ORDER BY a.attnum
     ) t`
  )
}

export async function getIndexes(
  conn: TenantDbConnection,
  table: string
): Promise<IndexInfo[]> {
  const rows = await queryJson<
    Array<{ name: string; columns: string[]; unique: boolean; primary: boolean; type: string }>
  >(
    conn,
    `SELECT COALESCE(json_agg(t), '[]') FROM (
       SELECT ic.relname AS name,
              ARRAY(SELECT a.attname FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum = ANY(i.indkey)) AS columns,
              i.indisunique AS unique, i.indisprimary AS primary,
              am.amname AS type
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_am am ON am.oid = ic.relam
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = ${quoteLiteral(table)} AND ${USER_SCHEMAS}
     ) t`
  )
  return rows.map((r) => ({
    name: r.name,
    columns: r.columns || [],
    unique: !!r.unique,
    primary: !!r.primary,
    type: (r.type || '').toUpperCase(),
  }))
}

export async function getForeignKeys(
  conn: TenantDbConnection,
  table: string
): Promise<ForeignKeyInfo[]> {
  return queryJson<ForeignKeyInfo[]>(
    conn,
    `SELECT COALESCE(json_agg(t), '[]') FROM (
       SELECT con.conname AS name,
              att.attname AS column,
              cl.relname AS "refTable",
              fatt.attname AS "refColumn",
              CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                   WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                   WHEN 'd' THEN 'SET DEFAULT' END AS "onUpdate",
              CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                   WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                   WHEN 'd' THEN 'SET DEFAULT' END AS "onDelete"
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class cl ON cl.oid = con.confrelid
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = con.confkey[1]
       WHERE con.contype = 'f' AND c.relname = ${quoteLiteral(table)} AND ${USER_SCHEMAS}
     ) t`
  )
}

// ─── Typed row reads (the data grid) ───────────────────────────────────────

export interface TableRowsOptions {
  limit?: number
  offset?: number
  orderBy?: string
  orderDir?: 'ASC' | 'DESC'
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

export async function getTableRows(
  conn: TenantDbConnection,
  table: string,
  opts: TableRowsOptions = {}
): Promise<TableRowsResult> {
  const columns = await getColumns(conn, table)
  if (columns.length === 0) throw new Error(`Table not found or has no columns: ${table}`)
  const colNames = new Set(columns.map((c) => c.name))
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  let where = ''
  if (opts.filterColumn && colNames.has(opts.filterColumn) && opts.filterValue != null) {
    // Cast to text so the same search works for non-text columns.
    where = ` WHERE ${quoteIdent(opts.filterColumn)}::text ILIKE ${quoteLiteral(
      `%${opts.filterValue}%`
    )}`
  }

  let orderBy = ''
  if (opts.orderBy && colNames.has(opts.orderBy)) {
    orderBy = ` ORDER BY ${quoteIdent(opts.orderBy)} ${
      opts.orderDir === 'DESC' ? 'DESC' : 'ASC'
    }`
  }

  const ref = quoteIdent(table)
  const [rows, totals] = await Promise.all([
    queryJson<Array<Record<string, unknown>>>(
      conn,
      `SELECT COALESCE(json_agg(_page), '[]') FROM (
         SELECT * FROM ${ref}${where}${orderBy} LIMIT ${limit} OFFSET ${offset}
       ) AS _page`
    ),
    queryJson<Array<{ n: number }>>(
      conn,
      `SELECT json_build_array(json_build_object('n', (SELECT COUNT(*) FROM ${ref}${where})))`
    ),
  ])

  return { columns, rows, total: Number(totals[0]?.n ?? rows.length), limit, offset }
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
    `SELECT json_build_array(json_build_object(
       'tables', (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE c.relkind IN ('r','p') AND ${USER_SCHEMAS}),
       'views',  (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE c.relkind IN ('v','m') AND ${USER_SCHEMAS}),
       'totalRows', (SELECT COALESCE(SUM(GREATEST(c.reltuples,0))::bigint,0) FROM pg_class c
                     JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE c.relkind IN ('r','p') AND ${USER_SCHEMAS}),
       'sizeBytes', pg_database_size(current_database())
     ))`
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

// ─── Row mutations ─────────────────────────────────────────────────────────

export interface RowMutationResult {
  affectedRows: number
  durationMs: number
}

export async function getPrimaryKey(
  conn: TenantDbConnection,
  table: string
): Promise<string[]> {
  const cols = await getColumns(conn, table)
  return cols.filter((c) => c.key === 'PRI').map((c) => c.name)
}

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  return quoteLiteral(String(v))
}

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
  const r = await runStatement(
    conn,
    `UPDATE ${quoteIdent(table)} SET ${sets.join(', ')} WHERE ${whereByKey(pk, key)}`
  )
  return { affectedRows: r.affectedRows ?? 0, durationMs: r.durationMs }
}

export async function insertRow(
  conn: TenantDbConnection,
  table: string,
  values: Record<string, unknown>
): Promise<RowMutationResult> {
  const cols = await getColumns(conn, table)
  const valid = new Set(cols.map((c) => c.name))
  const entries = Object.entries(values).filter(([c]) => valid.has(c))
  if (entries.length === 0) throw new Error('No valid columns provided to insert')
  const r = await runStatement(
    conn,
    `INSERT INTO ${quoteIdent(table)} (${entries
      .map(([c]) => quoteIdent(c))
      .join(', ')}) VALUES (${entries.map(([, v]) => sqlValue(v)).join(', ')})`
  )
  return { affectedRows: r.affectedRows ?? 0, durationMs: r.durationMs }
}

export async function deleteRow(
  conn: TenantDbConnection,
  table: string,
  key: Record<string, unknown>
): Promise<RowMutationResult> {
  const pk = await getPrimaryKey(conn, table)
  const r = await runStatement(
    conn,
    `DELETE FROM ${quoteIdent(table)} WHERE ${whereByKey(pk, key)}`
  )
  return { affectedRows: r.affectedRows ?? 0, durationMs: r.durationMs }
}

// ─── Table operations ──────────────────────────────────────────────────────

export type TableOp = 'truncate' | 'drop' | 'rename' | 'optimize' | 'analyze'
const SAFE_IDENT = /^[A-Za-z0-9_$]{1,63}$/

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
    // Postgres has no OPTIMIZE; VACUUM (FULL is too heavy for a shared box)
    // reclaims space and refreshes statistics, which is the intent.
    case 'optimize':
      sql = `VACUUM ANALYZE ${quoteIdent(table)}`
      break
    case 'analyze':
      sql = `ANALYZE ${quoteIdent(table)}`
      break
    case 'rename':
      if (!newName || !SAFE_IDENT.test(newName)) {
        throw new Error('Invalid new table name (letters, digits, _ and $ only)')
      }
      sql = `ALTER TABLE ${quoteIdent(table)} RENAME TO ${quoteIdent(newName)}`
      break
    default:
      throw new Error('Unknown table operation')
  }
  const r = await runStatement(conn, sql)
  return { ok: true, message: r.note || 'Done', durationMs: r.durationMs }
}

// ─── Export ────────────────────────────────────────────────────────────────

export type DumpMode = 'full' | 'structure' | 'data'

export async function dumpDatabase(
  conn: TenantDbConnection,
  mode: DumpMode = 'full'
): Promise<{ sql: string; durationMs: number }> {
  const extraArgs =
    mode === 'structure' ? ['--schema-only'] : mode === 'data' ? ['--data-only'] : []
  const r = await execDump({
    engine: 'postgres',
    container: conn.container,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    extraArgs,
  })
  if (!r.ok) {
    const e = parseSqlError(r.stderr)
    throw Object.assign(new Error(e.message || 'Export failed'), e)
  }
  return { sql: r.stdout, durationMs: r.durationMs }
}

// ─── Import ────────────────────────────────────────────────────────────────

export async function importSql(
  conn: TenantDbConnection,
  sql: string
): Promise<{ ok: boolean; error?: string; durationMs: number }> {
  // ON_ERROR_STOP makes psql fail on the first bad statement instead of
  // ploughing on and leaving a half-applied dump.
  const r = await psql(conn, sql, ['-X', '-v', 'ON_ERROR_STOP=1'], 300_000)
  if (!r.ok) {
    const e = parseSqlError(r.stderr)
    return { ok: false, error: e.message || r.stderr.slice(0, 300), durationMs: r.durationMs }
  }
  return { ok: true, durationMs: r.durationMs }
}
