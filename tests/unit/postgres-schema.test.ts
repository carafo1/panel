/**
 * The installer swaps in prisma/schema.postgres.prisma when the operator picks
 * PostgreSQL. It once fell 12 models behind schema.prisma, so a PostgreSQL
 * install queried tables that did not exist. These tests keep the two in step.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  buildPostgresSchema,
  POSTGRES_SCHEMA_PATH,
  SQLITE_SCHEMA_PATH,
} from '../../scripts/postgres-schema'

const sqlite = readFileSync(SQLITE_SCHEMA_PATH, 'utf8')
const postgres = readFileSync(POSTGRES_SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n')

const models = (schema: string) => [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]).sort()

describe('prisma/schema.postgres.prisma', () => {
  it('is regenerated from schema.prisma (run `bun run db:pg-schema` if this fails)', () => {
    expect(postgres).toBe(buildPostgresSchema(sqlite))
  })

  it('has exactly the same models as schema.prisma', () => {
    expect(models(postgres)).toEqual(models(sqlite))
  })

  it('targets PostgreSQL with pgvector', () => {
    expect(postgres).toContain('provider   = "postgresql"')
    expect(postgres).toContain('extensions = [vector]')
    expect(postgres).not.toContain('"sqlite"')
  })

  it('adds the embedding columns src/lib/embeddings.ts queries', () => {
    for (const model of ['Project', 'Deployment', 'AuditLog']) {
      const body = postgres.match(new RegExp(`^model ${model} \\{\\n([\\s\\S]*?)^\\}`, 'm'))?.[1] ?? ''
      expect(body).toContain('embedding Unsupported("vector(1536)")?')
    }
    expect(postgres.match(/embedding Unsupported/g)?.length).toBe(3)
  })

  it('refuses a schema it cannot transform instead of writing a broken file', () => {
    expect(() => buildPostgresSchema('model User {\n  id String @id\n}\n')).toThrow()
  })
})
