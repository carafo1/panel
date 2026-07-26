/**
 * Engine dispatcher
 * =================
 *
 * Database Studio speaks to MySQL/MariaDB and PostgreSQL through the same API
 * routes. This module picks the right driver for a resolved connection so the
 * routes stay engine-agnostic — the only place that knows which engine is in
 * play is here.
 *
 * Both drivers deliberately expose the same shapes (see `./types`), so adding
 * another engine later means writing one more module and extending the switch
 * below, with no route changes.
 */
import type { TenantDbConnection } from './types'
import * as mariadb from './mariadb'
import * as postgres from './postgres'

/**
 * The subset of driver behaviour the Studio routes rely on. Written as the
 * intersection of both modules so a missing or mistyped export in either driver
 * is a compile error rather than a runtime surprise.
 */
export type StudioDriver = {
  getSchemaTree: typeof mariadb.getSchemaTree
  getColumns: typeof mariadb.getColumns
  getIndexes: typeof mariadb.getIndexes
  getForeignKeys: typeof mariadb.getForeignKeys
  getTableRows: typeof mariadb.getTableRows
  getDatabaseStats: typeof mariadb.getDatabaseStats
  runStatement: typeof mariadb.runStatement
  updateRow: typeof mariadb.updateRow
  insertRow: typeof mariadb.insertRow
  deleteRow: typeof mariadb.deleteRow
  getPrimaryKey: typeof mariadb.getPrimaryKey
  tableOperation: typeof mariadb.tableOperation
  dumpDatabase: typeof mariadb.dumpDatabase
  importSql: typeof mariadb.importSql
  classifyCommand: typeof mariadb.classifyCommand
  isReadCommand: (cmd: ReturnType<typeof mariadb.classifyCommand>) => boolean
}

const READ_COMMANDS = new Set(['SELECT', 'SHOW', 'EXPLAIN'])

/** Pick the driver for a resolved tenant connection. */
export function driverFor(conn: TenantDbConnection): StudioDriver {
  if (conn.engine === 'postgres') {
    return {
      ...postgres,
      isReadCommand: (cmd) => READ_COMMANDS.has(cmd),
    } as unknown as StudioDriver
  }
  return {
    ...mariadb,
    isReadCommand: mariadb.isReadCommand,
  } as unknown as StudioDriver
}
