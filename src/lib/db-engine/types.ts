/**
 * Database Management Module — shared types
 * =========================================
 *
 * The DB-management module ("Database Studio") lets a tenant browse and operate
 * their OWN database — which physically lives in a dedicated MariaDB/MySQL/
 * Postgres Docker container (see `src/lib/vps/database.ts`). Every operation
 * runs as the tenant's NON-root database user, so isolation is enforced by the
 * database engine itself, not just by our app layer.
 *
 * Transport note: the panel host cannot open a TCP socket to a container's
 * private `deployhub`-network IP, so all SQL is executed via `docker exec`
 * (locally when the project's server is this box; over SSH for remote servers).
 * See `exec.ts`.
 */

export type DbEngine = 'mysql' | 'mariadb' | 'postgres'

/**
 * A fully-resolved, ready-to-use handle for a single tenant database. Produced
 * by the guard (`resolveTenantDatabase`) after ownership + auth checks. The
 * decrypted `password` never leaves the server process.
 */
export interface TenantDbConnection {
  /** WebsiteDatabase.id */
  id: string
  engine: DbEngine
  /** docker container name (WebsiteDatabase.externalRef or .host) */
  container: string
  host: string
  port: number
  /** the tenant's database name */
  database: string
  /** non-root tenant user */
  user: string
  /** decrypted plaintext password — server-only, never serialized to the client */
  password: string
  /** true when the project's server is this host (local docker exec) */
  local: boolean
}

// ─── Query results ─────────────────────────────────────────────────────────

export interface QueryColumn {
  name: string
  /** SQL type when known (from result metadata or information_schema) */
  type?: string
}

/** The SQL verb we classified a statement as. */
export type SqlCommand =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'CREATE'
  | 'ALTER'
  | 'DROP'
  | 'TRUNCATE'
  | 'SHOW'
  | 'EXPLAIN'
  | 'USE'
  | 'SET'
  | 'CALL'
  | 'OTHER'

export interface QueryResult {
  columns: QueryColumn[]
  /** result rows as plain objects keyed by column name */
  rows: Array<Record<string, unknown>>
  rowCount: number
  /** for write statements */
  affectedRows?: number
  durationMs: number
  command: SqlCommand
  /** true when we injected/enforced a row cap and there may be more rows */
  truncated?: boolean
  /** human note, e.g. "4 rows in set" or an engine warning */
  note?: string
}

// ─── Schema introspection ──────────────────────────────────────────────────

export interface SchemaObjectSummary {
  name: string
  kind: 'table' | 'view'
  rows: number | null
  sizeBytes: number | null
  engine?: string | null
  comment?: string | null
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  key: string // PRI | UNI | MUL | ''
  default: string | null
  extra: string // auto_increment, etc.
  comment?: string
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  type: string // BTREE, FULLTEXT, ...
}

export interface ForeignKeyInfo {
  name: string
  column: string
  refTable: string
  refColumn: string
  onUpdate?: string
  onDelete?: string
}

export interface RoutineInfo {
  name: string
  kind: 'PROCEDURE' | 'FUNCTION'
  returns?: string | null
}

export interface TriggerInfo {
  name: string
  event: string // INSERT | UPDATE | DELETE
  table: string
  timing: string // BEFORE | AFTER
}

/** The full left-sidebar tree payload for the Database Explorer. */
export interface SchemaTree {
  database: string
  engine: DbEngine
  tables: SchemaObjectSummary[]
  views: SchemaObjectSummary[]
  routines: RoutineInfo[]
  triggers: TriggerInfo[]
  collectedAt: string
}

/** A structured error surfaced to the client (never leaks credentials). */
export interface DbEngineError {
  message: string
  /** engine error code when parseable, e.g. "1064" for a syntax error */
  code?: string
  sqlState?: string
}
