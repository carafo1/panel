import { NextResponse } from 'next/server'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { db } from '@/lib/db'
import ZAI from 'z-ai-web-dev-sdk'
import { semanticSearch, isPgvectorEnabled } from '@/lib/embeddings'

// ── In-memory conversation store ────────────────────────────────────────
const MAX_MESSAGES_PER_SESSION = 20
const MAX_SESSIONS = 100

interface ConversationMessage {
  role: 'assistant' | 'user'
  content: string
}

const conversations = new Map<string, ConversationMessage[]>()

const SYSTEM_PROMPT = `You are Apsamo Panel AI Assistant, an expert in web hosting, domain management, deployment, CI/CD pipelines, and cloud infrastructure.

When responding to user questions about THEIR projects, deployments, or activity, use the "User Context" section provided at the top of each message. This context is retrieved via semantic search over the user's actual data — projects, deployments, audit logs.

Guidelines:
- If the user asks about "my projects" or "my deployments" and context is provided, reference specific projects by name.
- If no context is provided (empty section), the user may not have data yet, or the query didn't match anything — say so.
- Be concise, helpful, and friendly.
- When suggesting commands or code, use markdown code blocks.
- When referencing a project, mention its status (running/failed/stopped) if relevant.
- For deployment failures, look at the build log snippet in the context to diagnose the issue.`

// Lazy-init ZAI singleton
let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null

async function getZAI() {
  if (!zaiInstance) {
    zaiInstance = await ZAI.create()
  }
  return zaiInstance
}

// Evict oldest session if we're at capacity
function evictIfNeeded() {
  if (conversations.size >= MAX_SESSIONS) {
    const firstKey = conversations.keys().next().value
    if (firstKey) conversations.delete(firstKey)
  }
}

// ── RAG: Decide whether to retrieve user context ─────────────────────────
// We only retrieve context for queries that are about the user's own data.
// General knowledge questions (e.g. "what is Docker?") skip retrieval.
const PERSONAL_QUERY_PATTERNS = [
  /\bmy\s+(projects?|deployments?|domains?|sites?|apps?|servers?|team|logs?|history|account|subscription|billing|plan)\b/i,
  /\b(what|which|show|list|find|status of|state of|how is|how many)\b.*\b(project|deployment|domain|site|app|server|team|user|payment|invoice)\b/i,
  /\b(recent|latest|last|failed|failing|running|stopped|error|broken)\b.*\b(project|deployment|build|app|site)\b/i,
  /\bwhat (did|happened|went wrong|failed)\b/i,
  /\bmy account\b/i,
  /\b(summarize|overview|summary)\b.*\b(account|projects?|deployments?|activity)\b/i,
]

function shouldRetrieveContext(query: string): boolean {
  return PERSONAL_QUERY_PATTERNS.some((p) => p.test(query))
}

// ── Retrieve user context via semantic search ────────────────────────────
async function retrieveUserContext(userId: string, query: string): Promise<string | null> {
  if (!shouldRetrieveContext(query)) return null

  try {
    const pgvectorReady = await isPgvectorEnabled()
    const results = await semanticSearch(userId, query, 8)

    if (results.length === 0) {
      // Fall back to a quick DB summary if semantic search returned nothing
      return await getUserSummary(userId)
    }

    const sections: string[] = []

    // Group results by table
    const projects = results.filter((r) => r.table === 'Project')
    const deployments = results.filter((r) => r.table === 'Deployment')
    const auditLogs = results.filter((r) => r.table === 'AuditLog')

    if (projects.length > 0) {
      sections.push('## Matching Projects')
      for (const p of projects) {
        const d = p.data as { name: string; description?: string; framework: string; status: string }
        sections.push(
          `- **${d.name}** (${d.framework}, status: ${d.status})${d.description ? ` — ${d.description}` : ''}  [similarity: ${((1 - p.score) * 100).toFixed(0)}%]`
        )
      }
    }

    if (deployments.length > 0) {
      sections.push('\n## Matching Deployments')
      for (const d of deployments) {
        const data = d.data as { branch: string; status: string; commit?: string | null; buildLog?: string | null }
        const logSnippet = (data.buildLog ?? '').slice(0, 300)
        sections.push(
          `- Branch **${data.branch}** — status: **${data.status}**${data.commit ? ` (commit ${data.commit.slice(0, 7)})` : ''}  [similarity: ${((1 - d.score) * 100).toFixed(0)}%]`
        )
        if (logSnippet && data.status === 'failed') {
          sections.push(`  Build log snippet:\n  \`\`\`\n  ${logSnippet}\n  \`\`\``)
        }
      }
    }

    if (auditLogs.length > 0) {
      sections.push('\n## Matching Activity')
      for (const a of auditLogs.slice(0, 5)) {
        const data = a.data as { action: string; resource: string; status: string }
        sections.push(`- ${data.action} on ${data.resource} — ${data.status}  [similarity: ${((1 - a.score) * 100).toFixed(0)}%]`)
      }
    }

    const header = pgvectorReady
      ? '## User Context (retrieved via pgvector semantic search)'
      : '## User Context (retrieved via keyword search)'

    return header + '\n\n' + sections.join('\n')
  } catch (err) {
    console.error('[assistant] context retrieval failed:', err)
    return null  // fail open — let LLM respond without context
  }
}

// ── Quick summary fallback (when semantic search returns nothing) ────────
async function getUserSummary(userId: string): Promise<string | null> {
  try {
    const [projectCount, runningProjects, failedDeployments, recentLogs] = await Promise.all([
      db.project.count({ where: { userId } }),
      db.project.count({ where: { userId, status: 'running' } }),
      db.deployment.count({ where: { userId, status: 'failed' } }),
      db.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { action: true, resource: true, status: true, createdAt: true },
      }),
    ])

    if (projectCount === 0 && recentLogs.length === 0) return null

    const lines: string[] = ['## User Context (summary)']
    lines.push(`- Total projects: ${projectCount} (${runningProjects} running)`)
    lines.push(`- Failed deployments: ${failedDeployments}`)
    if (recentLogs.length > 0) {
      lines.push('- Recent activity:')
      for (const log of recentLogs) {
        lines.push(`  - ${log.action} on ${log.resource} (${log.status}) — ${log.createdAt.toISOString()}`)
      }
    }
    return lines.join('\n')
  } catch {
    return null
  }
}

// ── POST /api/assistant/chat ────────────────────────────────────────────
export async function POST(request: Request) {
  try {
    // Auth verification
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { message, sessionId: providedSessionId } = body as {
      message?: string
      sessionId?: string
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      )
    }

    // Create or reuse session
    const sessionId = providedSessionId || `${decoded.userId}-${Date.now()}`

    let history = conversations.get(sessionId)
    if (!history) {
      evictIfNeeded()
      history = [{ role: 'assistant', content: SYSTEM_PROMPT }]
      conversations.set(sessionId, history)
    }

    // Add user message
    history.push({ role: 'user', content: message.trim() })

    // Trim old messages if exceeding limit (keep system prompt at index 0)
    if (history.length > MAX_MESSAGES_PER_SESSION + 1) {
      history = [
        history[0],
        ...history.slice(-(MAX_MESSAGES_PER_SESSION)),
      ]
      conversations.set(sessionId, history)
    }

    // ── RAG: Retrieve relevant user data via semantic search ─────────────
    // For queries about "my projects", "deployments", "what failed", etc.,
    // we pull the user's actual data and inject it as context for the LLM.
    const userContext = await retrieveUserContext(decoded.userId, message)

    // Build the augmented message: prepend context to the latest user message
    const augmentedHistory = userContext
      ? [
          ...history.slice(0, -1),  // all messages except the latest user one
          {
            role: 'user' as const,
            content: `${userContext}\n\n---\n\nUser question: ${message.trim()}`,
          },
        ]
      : history

    // Call LLM
    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: augmentedHistory,
      thinking: { type: 'disabled' },
    })

    const aiResponse = completion.choices?.[0]?.message?.content || 'Sorry, I could not generate a response. Please try again.'

    // Add AI response to history
    history.push({ role: 'assistant', content: aiResponse })

    // Trim again if needed
    if (history.length > MAX_MESSAGES_PER_SESSION + 1) {
      history = [
        history[0],
        ...history.slice(-(MAX_MESSAGES_PER_SESSION)),
      ]
      conversations.set(sessionId, history)
    }

    return NextResponse.json({
      response: aiResponse,
      sessionId,
    })
  } catch (error) {
    console.error('[Assistant API Error]', error)
    return NextResponse.json(
      { error: 'Failed to generate response' },
      { status: 500 }
    )
  }
}

// ── DELETE /api/assistant/chat ───────────────────────────────────────────
export async function DELETE(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get('sessionId')

    if (sessionId) {
      conversations.delete(sessionId)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[Assistant API Error]', error)
    return NextResponse.json(
      { error: 'Failed to clear session' },
      { status: 500 }
    )
  }
}
