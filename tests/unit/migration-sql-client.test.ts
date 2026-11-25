/**
 * The import talks to the site's database through `docker exec`. MariaDB 11
 * images ship only the `mariadb` client (no `mysql` alias), so a hard-coded
 * `mysql` made every import into a fresh MariaDB database fail with
 * "did not become reachable in time". The commands must pick whichever client
 * the container has.
 */
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { importSqlDump, waitForDatabase, IN_CONTAINER_SQL_CLIENT } from '../../src/lib/migration/wordpress'

function fakeClient(reply: (cmd: string) => { stdout?: string; code?: number }) {
  const commands: string[] = []
  const client = {
    exec(cmd: string, _opts: unknown, cb: (err: Error | null, stream: EventEmitter & { stderr: EventEmitter }) => void) {
      commands.push(cmd)
      const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), end() {} })
      cb(null, stream)
      const { stdout = '', code = 0 } = reply(cmd)
      queueMicrotask(() => {
        if (stdout) stream.emit('data', Buffer.from(stdout))
        stream.emit('close', code)
      })
    },
  }
  return { client: client as never, commands }
}

const DB = {
  host: 'deployhub-db-x',
  name: 'wp_x',
  user: 'wp_x',
  password: 'not-a-real-password',
  tablePrefix: 'wp_',
  container: 'deployhub-db-x',
}

describe('SQL client inside the database container', () => {
  test('resolves mariadb or mysql in the container shell', () => {
    expect(IN_CONTAINER_SQL_CLIENT).toContain('command -v mariadb')
    expect(IN_CONTAINER_SQL_CLIENT).toContain('command -v mysql')
  })

  test('the readiness probe and the import use it, never a bare mysql', async () => {
    const { client, commands } = fakeClient((cmd) =>
      cmd.includes('information_schema') ? { stdout: '12\n' } : {}
    )
    await waitForDatabase(client, DB, { attempts: 1 })
    const r = await importSqlDump(client, '/w/dump.sql.gz', DB)
    expect(r.tablesImported).toBe(12)
    expect(commands.length).toBeGreaterThanOrEqual(3)
    for (const c of commands) {
      expect(c).toContain('command -v mariadb || command -v mysql')
      expect(c).not.toMatch(/'mysql --default/)
      // The password travels in the environment, never as an argument.
      expect(c).not.toContain('-pnot-a-real-password')
    }
  })
})
