/**
 * scripts/populate-embeddings.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Populates pgvector embedding columns for all existing Projects, Deployments,
 * and AuditLogs.
 *
 * Usage:
 *   bun run scripts/populate-embeddings.ts
 *
 * Run this after switching to PostgreSQL (DB_ENGINE=postgres) to enable
 * semantic search in the AI assistant.
 *
 * Idempotent — safe to re-run. Updates embeddings for all rows (useful when
 * you change the embedding model or want to re-index after schema changes).
 * ════════════════════════════════════════════════════════════════════════════
 */

import { db } from '../src/lib/db'
import {
  isPgvectorEnabled,
  generateEmbedding,
  vectorToPgLiteral,
  projectToText,
  deploymentToText,
  auditLogToText,
} from '../src/lib/embeddings'

async function main() {
  console.log('=== Apsamo Panel — Populate Embeddings ===\n')

  if (!(await isPgvectorEnabled())) {
    console.error('❌ pgvector is not enabled.')
    console.error('   Make sure DB_ENGINE=postgres in .env and pgvector extension is installed.')
    console.error('   Run: bash deploy/scripts/install-postgres.sh')
    process.exit(1)
  }

  // ── Projects ──────────────────────────────────────────────────────────
  console.log('── Embedding Projects ──')
  const projects = await db.project.findMany({
    select: {
      id: true, name: true, description: true, framework: true, stack: true,
      status: true, subdomain: true, customDomain: true,
      deploymentMethod: true, runtime: true,
    },
  })
  console.log(`  Found ${projects.length} projects`)
  let i = 0
  for (const p of projects) {
    i++
    const text = projectToText(p)
    try {
      const vec = await generateEmbedding(text)
      const lit = vectorToPgLiteral(vec)
      await db.$executeRaw`UPDATE "Project" SET embedding = ${lit}::vector WHERE id = ${p.id}`
      console.log(`  [${i}/${projects.length}] ${p.name} ✓`)
    } catch (err) {
      console.error(`  [${i}/${projects.length}] ${p.name} ✗ ${(err as Error).message}`)
    }
  }

  // ── Deployments ───────────────────────────────────────────────────────
  console.log('\n── Embedding Deployments ──')
  const deployments = await db.deployment.findMany({
    select: {
      id: true, commit: true, branch: true, status: true,
      buildLog: true, triggeredBy: true,
      project: { select: { name: true } },
    },
  })
  console.log(`  Found ${deployments.length} deployments`)
  i = 0
  for (const d of deployments) {
    i++
    const text = deploymentToText(d, d.project?.name)
    try {
      const vec = await generateEmbedding(text)
      const lit = vectorToPgLiteral(vec)
      await db.$executeRaw`UPDATE "Deployment" SET embedding = ${lit}::vector WHERE id = ${d.id}`
      console.log(`  [${i}/${deployments.length}] ${d.project?.name ?? 'unknown'} #${d.id.slice(-6)} (${d.status}) ✓`)
    } catch (err) {
      console.error(`  [${i}/${deployments.length}] ${d.id} ✗ ${(err as Error).message}`)
    }
  }

  // ── AuditLogs (limit to last 1000 to keep runtime reasonable) ─────────
  console.log('\n── Embedding AuditLogs (last 1000) ──')
  const auditLogs = await db.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 1000,
    select: { id: true, action: true, resource: true, resourceId: true, status: true, metadata: true },
  })
  console.log(`  Found ${auditLogs.length} audit logs`)
  i = 0
  for (const a of auditLogs) {
    i++
    const text = auditLogToText(a)
    try {
      const vec = await generateEmbedding(text)
      const lit = vectorToPgLiteral(vec)
      await db.$executeRaw`UPDATE "AuditLog" SET embedding = ${lit}::vector WHERE id = ${a.id}`
      if (i % 50 === 0) console.log(`  [${i}/${auditLogs.length}] processed`)
    } catch (err) {
      console.error(`  [${i}/${auditLogs.length}] ${a.id} ✗ ${(err as Error).message}`)
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('\n=== Done ===')
  console.log(`  Projects:    ${projects.length} embeddings`)
  console.log(`  Deployments: ${deployments.length} embeddings`)
  console.log(`  AuditLogs:   ${auditLogs.length} embeddings`)
  console.log('')
  console.log('AI assistant now has semantic search enabled.')
  console.log('Try: curl http://localhost:3000/api/assistant/search?q=my+failed+wordpress -H "Authorization: Bearer <token>"')

  await db.$disconnect()
  process.exit(0)
}

main().catch((err) => {
  console.error('❌ Fatal:', err)
  process.exit(1)
})
