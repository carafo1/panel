/**
 * src/lib/embeddings.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Vector embedding utilities for AI semantic search.
 *
 * Uses the z-ai-web-dev-sdk chat completion API to generate text embeddings
 * by prompting the model to produce a normalized feature vector. This is a
 * pragmatic fallback for environments without a dedicated embeddings endpoint.
 *
 * When DB_ENGINE=postgres + pgvector is available, the resulting 1536-dim
 * vectors are stored in the `embedding` column of Project/Deployment/AuditLog
 * and queried via `<=>` (cosine distance) for semantic similarity search.
 *
 * When DB_ENGINE=sqlite, embeddings are computed at query time (slower) and
 * similarity is approximated via keyword overlap (no vector storage).
 * ════════════════════════════════════════════════════════════════════════════
 */

import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'

// ── Configuration ─────────────────────────────────────────────────────────

const EMBEDDING_DIM = 1536  // matches pgvector column size in schema.postgres.prisma

/**
 * Returns true if the panel is running on PostgreSQL with pgvector enabled.
 * Use this to gate vector-search code paths.
 */
export async function isPgvectorEnabled(): Promise<boolean> {
  if (process.env.DB_ENGINE !== 'postgres') return false
  try {
    const result = await db.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `
    return result.length > 0
  } catch {
    return false
  }
}

// ── Embedding generation ──────────────────────────────────────────────────

let _zai: ZAI | null = null
async function getZAI(): Promise<ZAI> {
  if (!_zai) _zai = await ZAI.create()
  return _zai
}

/**
 * Generate a 1536-dim embedding for the given text.
 *
 * Strategy: ask the LLM to produce a sparse feature representation as a
 * comma-separated list of "index:value" pairs (think TF-IDF style), then
 * densify into a fixed-size Float32 vector.
 *
 * This is NOT a learned embedding (it won't catch deep semantic similarity
 * like "king → queen"), but it captures term frequency + synonym expansion
 * from the LLM's vocabulary, which is good enough for project/log search
 * across a single user's data (typically <10k rows).
 *
 * For users who need real embeddings, swap this function with a call to
 * OpenAI's text-embedding-3-small API or run a local sentence-transformers
 * model — the rest of the pipeline (storage + cosine search) is identical.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  // Truncate to keep LLM prompt small (embeddings of long text aren't more useful)
  const truncated = text.slice(0, 4000)

  const zai = await getZAI()
  const response = await zai.chat.completions.create({
    model: 'glm-4-flash',
    messages: [
      {
        role: 'system',
        content: `You are an embedding generator. For the user's text, output a list of 50 keywords/phrases that best describe its semantic content. Output ONLY a comma-separated list, no other text. Be specific. Example input: "WordPress site for bakery" → output: "wordpress, bakery, website, cms, php, mysql, blog, food, business, content management"`,
      },
      { role: 'user', content: truncated },
    ],
    stream: false,
  })

  const keywordStr: string = response?.choices?.[0]?.message?.content ?? ''
  const keywords = keywordStr
    .toLowerCase()
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/[^a-z0-9\s-]/g, ''))
    .filter((s) => s.length > 1 && s.length < 50)
    .slice(0, 50)

  // Hash each keyword into the 1536-dim vector space.
  // Multiple keywords may collide to the same dimension — that's fine, it
  // creates a soft "topic cluster" signal. The L2-normalized result is
  // what we store + compare with `<=>`.
  const vec = new Float32Array(EMBEDDING_DIM)
  for (const kw of keywords) {
    const hash = hashString(kw) % EMBEDDING_DIM
    vec[hash] += 1
    // Also boost bigram halves — "wordpress site" → also hash "wordpress" + "site"
    const parts = kw.split(/\s+/)
    if (parts.length > 1) {
      for (const p of parts) {
        const h = hashString(p) % EMBEDDING_DIM
        vec[h] += 0.5
      }
    }
  }

  // L2 normalize so cosine distance = Euclidean distance (pgvector's `<=>`)
  let norm = 0
  for (const v of vec) norm += v * v
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm
  }

  return vec
}

function hashString(s: string): number {
  // FNV-1a hash — fast + good distribution for short strings
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Convert Float32Array → PostgreSQL vector literal: "[0.1,0.2,...]" */
export function vectorToPgLiteral(vec: Float32Array): string {
  const parts: string[] = []
  for (let i = 0; i < vec.length; i++) {
    parts.push(vec[i].toFixed(6))
  }
  return `[${parts.join(',')}]`
}

/** Convert Float32Array → JSON string for SQLite fallback storage */
export function vectorToJson(vec: Float32Array): string {
  return JSON.stringify(Array.from(vec))
}

// ── Similarity search ─────────────────────────────────────────────────────

export interface SearchResult {
  id: string
  table: 'Project' | 'Deployment' | 'AuditLog'
  score: number  // 0 = identical, 2 = opposite (cosine distance)
  data: Record<string, unknown>
}

/**
 * Semantic search across all embeddable entities for a given user.
 *
 * @param userId  restricts search to this user's data
 * @param query   natural language query (e.g. "my failing WordPress deployments")
 * @param limit   max results (default 10)
 */
export async function semanticSearch(
  userId: string,
  query: string,
  limit = 10
): Promise<SearchResult[]> {
  const pgvectorReady = await isPgvectorEnabled()

  if (pgvectorReady) {
    return semanticSearchPgvector(userId, query, limit)
  }
  return semanticSearchFallback(userId, query, limit)
}

/**
 * PostgreSQL + pgvector path — true vector similarity search.
 * Uses `<=>` (cosine distance) for ranking.
 */
async function semanticSearchPgvector(
  userId: string,
  query: string,
  limit: number
): Promise<SearchResult[]> {
  const queryVec = await generateEmbedding(query)
  const queryLit = vectorToPgLiteral(queryVec)

  // Search all three tables in parallel
  const [projects, deployments, auditLogs] = await Promise.all([
    db.$queryRaw<Array<{ id: string; score: number; name: string; description: string | null; framework: string; status: string }>>`
      SELECT id, name, description, framework, status,
             (embedding <=> ${queryLit}::vector) AS score
      FROM "Project"
      WHERE "userId" = ${userId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${queryLit}::vector
      LIMIT ${limit}
    `,
    db.$queryRaw<Array<{ id: string; score: number; commit: string | null; branch: string; status: string; "buildLog": string | null }>>`
      SELECT id, commit, branch, status, "buildLog",
             (embedding <=> ${queryLit}::vector) AS score
      FROM "Deployment"
      WHERE "userId" = ${userId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${queryLit}::vector
      LIMIT ${limit}
    `,
    db.$queryRaw<Array<{ id: string; score: number; action: string; resource: string; status: string; metadata: string }>>`
      SELECT id, action, resource, status, metadata,
             (embedding <=> ${queryLit}::vector) AS score
      FROM "AuditLog"
      WHERE ("userId" = ${userId} OR "userId" IS NULL) AND embedding IS NOT NULL
      ORDER BY embedding <=> ${queryLit}::vector
      LIMIT ${limit}
    `,
  ])

  const results: SearchResult[] = [
    ...projects.map((p) => ({ id: p.id, table: 'Project' as const, score: p.score, data: p })),
    ...deployments.map((d) => ({ id: d.id, table: 'Deployment' as const, score: d.score, data: d })),
    ...auditLogs.map((a) => ({ id: a.id, table: 'AuditLog' as const, score: a.score, data: a })),
  ]

  return results.sort((a, b) => a.score - b.score).slice(0, limit)
}

/**
 * SQLite fallback — keyword-based search (no vectors).
 * Used when DB_ENGINE=sqlite OR pgvector extension not installed.
 */
async function semanticSearchFallback(
  userId: string,
  query: string,
  limit: number
): Promise<SearchResult[]> {
  // Generate keywords from the query (same LLM call as embedding, but we
  // only need the keyword list, not the vector)
  const zai = await getZAI()
  const response = await zai.chat.completions.create({
    model: 'glm-4-flash',
    messages: [
      {
        role: 'system',
        content: 'Extract 10 keywords from the user query. Output ONLY comma-separated lowercase keywords.',
      },
      { role: 'user', content: query },
    ],
    stream: false,
  })

  const keywords: string[] = (response?.choices?.[0]?.message?.content ?? '')
    .toLowerCase()
    .split(/[,\n]/)
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 1)
    .slice(0, 10)

  if (keywords.length === 0) return []

  // Simple ILIKE search across all relevant text columns
  const pattern = `%${keywords.join('%')}%`

  const projects = await db.project.findMany({
    where: {
      userId,
      OR: [
        { name: { contains: keywords[0] } },
        { description: { contains: keywords[0] } },
        { framework: { contains: keywords[0] } },
      ],
    },
    take: limit,
  })

  // Score = count of keyword matches found in name+description+framework
  return projects.map((p) => {
    const text = `${p.name} ${p.description ?? ''} ${p.framework} ${p.status}`.toLowerCase()
    const score = keywords.filter((k) => text.includes(k)).length
    return {
      id: p.id,
      table: 'Project' as const,
      score: -score, // negative so more matches = lower score (closer to 0)
      data: { id: p.id, name: p.name, description: p.description, framework: p.framework, status: p.status },
    }
  }).sort((a, b) => a.score - b.score).slice(0, limit)
}

// ── Embedding population (background job) ────────────────────────────────

/**
 * Build the text representation of a Project for embedding.
 * Concatenates the most semantically meaningful fields.
 */
export function projectToText(p: {
  name: string
  description: string | null
  framework: string
  stack: string
  status: string
  subdomain: string
  customDomain: string | null
  deploymentMethod: string | null
  runtime: string | null
}): string {
  return [
    `Project: ${p.name}`,
    p.description ? `Description: ${p.description}` : '',
    `Framework: ${p.framework}`,
    `Stack: ${p.stack}`,
    `Status: ${p.status}`,
    `URL: ${p.subdomain}`,
    p.customDomain ? `Custom domain: ${p.customDomain}` : '',
    p.deploymentMethod ? `Deployment method: ${p.deploymentMethod}` : '',
    p.runtime ? `Runtime: ${p.runtime}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * Build the text representation of a Deployment for embedding.
 */
export function deploymentToText(d: {
  commit: string | null
  branch: string
  status: string
  buildLog: string | null
  triggeredBy: string
}, projectName?: string): string {
  const logSnippet = (d.buildLog ?? '').slice(0, 2000)
  return [
    projectName ? `Project: ${projectName}` : '',
    `Branch: ${d.branch}`,
    d.commit ? `Commit: ${d.commit}` : '',
    `Status: ${d.status}`,
    `Triggered by: ${d.triggeredBy}`,
    logSnippet ? `Build log (truncated):\n${logSnippet}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * Build the text representation of an AuditLog for embedding.
 */
export function auditLogToText(a: {
  action: string
  resource: string
  resourceId: string | null
  status: string
  metadata: string
}): string {
  return [
    `Action: ${a.action}`,
    `Resource: ${a.resource}`,
    a.resourceId ? `Resource ID: ${a.resourceId}` : '',
    `Status: ${a.status}`,
    `Metadata: ${(a.metadata ?? '').slice(0, 1000)}`,
  ].filter(Boolean).join('\n')
}

/**
 * Update the embedding for a single Project.
 * Safe to call on SQLite (no-op) or PostgreSQL without pgvector (no-op).
 */
export async function updateProjectEmbedding(projectId: string): Promise<void> {
  if (!(await isPgvectorEnabled())) return

  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) return

  const text = projectToText(project)
  const vec = await generateEmbedding(text)
  const lit = vectorToPgLiteral(vec)

  await db.$executeRaw`
    UPDATE "Project" SET embedding = ${lit}::vector WHERE id = ${projectId}
  `
}

/**
 * Update the embedding for a single Deployment.
 */
export async function updateDeploymentEmbedding(deploymentId: string): Promise<void> {
  if (!(await isPgvectorEnabled())) return

  const deployment = await db.deployment.findUnique({
    where: { id: deploymentId },
    include: { project: { select: { name: true } } },
  })
  if (!deployment) return

  const text = deploymentToText(deployment, deployment.project?.name)
  const vec = await generateEmbedding(text)
  const lit = vectorToPgLiteral(vec)

  await db.$executeRaw`
    UPDATE "Deployment" SET embedding = ${lit}::vector WHERE id = ${deploymentId}
  `
}

/**
 * Update the embedding for a single AuditLog.
 */
export async function updateAuditLogEmbedding(auditLogId: string): Promise<void> {
  if (!(await isPgvectorEnabled())) return

  const log = await db.auditLog.findUnique({ where: { id: auditLogId } })
  if (!log) return

  const text = auditLogToText(log)
  const vec = await generateEmbedding(text)
  const lit = vectorToPgLiteral(vec)

  await db.$executeRaw`
    UPDATE "AuditLog" SET embedding = ${lit}::vector WHERE id = ${auditLogId}
  `
}
