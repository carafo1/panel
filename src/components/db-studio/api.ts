/**
 * Database Studio — client API helper
 * ===================================
 * Thin typed wrapper over the Studio endpoints. Requests are authenticated by
 * the panel's httpOnly session cookie (src/lib/session.ts), and error
 * responses are normalised into thrown Errors the UI can display.
 */
'use client'

import type {
  SchemaTree,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  QueryResult,
} from '@/lib/db-engine/types'

export interface DbStats {
  database: string
  tableCount: number
  viewCount: number
  totalRows: number
  sizeBytes: number
}

export interface TableRowsResult {
  columns: ColumnInfo[]
  rows: Array<Record<string, unknown>>
  total: number
  limit: number
  offset: number
}

export interface TableStructure {
  table: string
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
    cache: 'no-store',
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = data as { error?: string; code?: string; sqlState?: string } | null
    const e = new Error(err?.error || `Request failed (${res.status})`)
    Object.assign(e, { status: res.status, code: err?.code, sqlState: err?.sqlState })
    throw e
  }
  return data as T
}

/** Build the base path for a given project + database. */
export function studioBase(projectId: string, dbId: string): string {
  return `/api/hosting/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(dbId)}`
}

export const studioApi = {
  schema: (p: string, d: string) =>
    req<{ schema: SchemaTree }>(`${studioBase(p, d)}/schema`).then((r) => r.schema),

  stats: (p: string, d: string) =>
    req<{ stats: DbStats }>(`${studioBase(p, d)}/stats`).then((r) => r.stats),

  rows: (
    p: string,
    d: string,
    table: string,
    opts: {
      limit?: number
      offset?: number
      orderBy?: string
      orderDir?: 'ASC' | 'DESC'
      filterColumn?: string
      filterValue?: string
    } = {}
  ) => {
    const q = new URLSearchParams()
    if (opts.limit != null) q.set('limit', String(opts.limit))
    if (opts.offset != null) q.set('offset', String(opts.offset))
    if (opts.orderBy) q.set('orderBy', opts.orderBy)
    if (opts.orderDir) q.set('orderDir', opts.orderDir)
    if (opts.filterColumn) q.set('filterColumn', opts.filterColumn)
    if (opts.filterValue) q.set('filterValue', opts.filterValue)
    return req<TableRowsResult>(
      `${studioBase(p, d)}/tables/${encodeURIComponent(table)}/rows?${q.toString()}`
    )
  },

  structure: (p: string, d: string, table: string) =>
    req<TableStructure>(
      `${studioBase(p, d)}/tables/${encodeURIComponent(table)}/structure`
    ),

  query: (p: string, d: string, sql: string, maxRows?: number) =>
    req<{ result: QueryResult }>(`${studioBase(p, d)}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql, maxRows }),
    }).then((r) => r.result),

  updateRow: (
    p: string,
    d: string,
    table: string,
    key: Record<string, unknown>,
    changes: Record<string, unknown>
  ) =>
    req<{ affectedRows: number }>(
      `${studioBase(p, d)}/tables/${encodeURIComponent(table)}/rows`,
      { method: 'PATCH', body: JSON.stringify({ key, changes }) }
    ),

  insertRow: (p: string, d: string, table: string, values: Record<string, unknown>) =>
    req<{ affectedRows: number }>(
      `${studioBase(p, d)}/tables/${encodeURIComponent(table)}/rows`,
      { method: 'POST', body: JSON.stringify({ values }) }
    ),

  deleteRow: (p: string, d: string, table: string, key: Record<string, unknown>) =>
    req<{ affectedRows: number }>(
      `${studioBase(p, d)}/tables/${encodeURIComponent(table)}/rows`,
      { method: 'DELETE', body: JSON.stringify({ key }) }
    ),

  tableOp: (
    p: string,
    d: string,
    table: string,
    op: 'truncate' | 'drop' | 'rename' | 'optimize' | 'analyze',
    newName?: string
  ) =>
    req<{ ok: boolean; message: string }>(
      `${studioBase(p, d)}/tables/${encodeURIComponent(table)}/op`,
      { method: 'POST', body: JSON.stringify({ op, newName }) }
    ),
}

/**
 * Download a mariadb-dump of the database. Fetched with the bearer token (a
 * plain <a href> can't send it), then streamed to a file via a blob URL.
 */
export async function exportDatabase(
  projectId: string,
  dbId: string,
  mode: 'full' | 'structure' | 'data'
): Promise<void> {
  const res = await fetch(`${studioBase(projectId, dbId)}/export?mode=${mode}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!res.ok) {
    let msg = `Export failed (${res.status})`
    try {
      msg = (await res.json()).error || msg
    } catch {
      /* non-JSON */
    }
    throw new Error(msg)
  }
  const blob = await res.blob()
  const cd = res.headers.get('Content-Disposition') || ''
  const m = cd.match(/filename="?([^"]+)"?/)
  const filename = m ? m[1] : `export-${mode}.sql`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Upload a .sql or .sql.gz file and run it against the database. */
export async function importDatabase(
  projectId: string,
  dbId: string,
  file: File
): Promise<{ ok: boolean; durationMs: number }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${studioBase(projectId, dbId)}/import`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `Import failed (${res.status})`)
  return data as { ok: boolean; durationMs: number }
}
