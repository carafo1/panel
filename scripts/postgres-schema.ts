/**
 * scripts/postgres-schema.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Builds prisma/schema.postgres.prisma from prisma/schema.prisma.
 *
 * The installer copies schema.postgres.prisma over schema.prisma when the
 * operator picks PostgreSQL. That file used to be maintained by hand, fell 12
 * models behind, and a PostgreSQL install shipped a panel whose code queried
 * tables that did not exist. Now schema.prisma is the only source of truth and
 * the PostgreSQL file is derived from it: same models, plus the pgvector
 * extension and the three embedding columns src/lib/embeddings.ts reads.
 *
 *   bun run db:pg-schema           rewrite prisma/schema.postgres.prisma
 *   bun run db:pg-schema --check   exit 1 if the committed file is stale
 *
 * tests/unit/postgres-schema.test.ts runs the same check in CI.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SQLITE_SCHEMA_PATH = join(import.meta.dir, '..', 'prisma', 'schema.prisma')
export const POSTGRES_SCHEMA_PATH = join(import.meta.dir, '..', 'prisma', 'schema.postgres.prisma')

const HEADER = `// ════════════════════════════════════════════════════════════════════════════
// GENERATED FILE — do not edit. Change prisma/schema.prisma, then run
//     bun run db:pg-schema
// It is the SQLite schema with the PostgreSQL datasource, the pgvector
// extension, and embedding columns for AI semantic search (src/lib/embeddings.ts).
// You can't query an Unsupported("vector(1536)") column through Prisma — use
// db.$queryRaw for similarity search.
// ════════════════════════════════════════════════════════════════════════════

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector] // pgvector — enables AI semantic search
}`

/** Models that carry a pgvector embedding, and what each embedding encodes. */
const EMBEDDINGS: Record<string, string> = {
  Project: 'Populated by src/lib/embeddings.ts when the project is created or updated.',
  Deployment: 'Embedding of project name + branch + commit + status + start of the build log.',
  AuditLog: 'Embedding of action + resource + status + start of the metadata.',
}

export function buildPostgresSchema(sqliteSchema: string): string {
  const src = sqliteSchema.replace(/\r\n/g, '\n')

  const generator = /^generator client \{[^}]*\}\n/m
  const datasource = /^datasource db \{[^}]*\}\n/m
  if (!generator.test(src) || !datasource.test(src)) {
    throw new Error('schema.prisma: could not find the generator/datasource blocks')
  }
  if (!/provider\s*=\s*"sqlite"/.test(src)) {
    throw new Error('schema.prisma: expected the sqlite provider')
  }

  let body = src.replace(generator, '').replace(datasource, '').replace(/^\n+/, '')

  for (const [model, note] of Object.entries(EMBEDDINGS)) {
    const block = new RegExp(`^model ${model} \\{\\n([\\s\\S]*?)^\\}`, 'm')
    const match = body.match(block)
    if (!match) throw new Error(`schema.prisma: model ${model} not found (needed for its embedding column)`)
    if (/^\s+embedding\s/m.test(match[1])) {
      throw new Error(`schema.prisma: model ${model} already has an "embedding" field`)
    }
    const column =
      `  // ── pgvector embedding (PostgreSQL only) ── ${note}\n` +
      `  embedding Unsupported("vector(1536)")?\n`
    body = body.replace(block, (whole) => whole.replace(/\n\}$/, `\n\n${column}}`))
  }

  return `${HEADER}\n\n${body.replace(/\n*$/, '\n')}`
}

if (import.meta.main) {
  const expected = buildPostgresSchema(readFileSync(SQLITE_SCHEMA_PATH, 'utf8'))
  let current = ''
  try {
    current = readFileSync(POSTGRES_SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    /* missing file counts as stale */
  }

  if (process.argv.includes('--check')) {
    if (current !== expected) {
      console.error('prisma/schema.postgres.prisma is out of date. Run: bun run db:pg-schema')
      process.exit(1)
    }
    console.log('prisma/schema.postgres.prisma is up to date.')
  } else {
    writeFileSync(POSTGRES_SCHEMA_PATH, expected)
    console.log(current === expected ? 'Already up to date.' : 'Wrote prisma/schema.postgres.prisma')
  }
}
