import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import ZAI from 'z-ai-web-dev-sdk'

// ── In-memory conversation store ────────────────────────────────────────
const MAX_MESSAGES_PER_SESSION = 20
const MAX_SESSIONS = 100

interface ConversationMessage {
  role: 'assistant' | 'user'
  content: string
}

const conversations = new Map<string, ConversationMessage[]>()

const SYSTEM_PROMPT =
  'You are APSAMO AI Assistant, an expert in web hosting, domain management, deployment, CI/CD pipelines, and cloud infrastructure. You help users with their hosting questions, deployment troubleshooting, and best practices. Be concise, helpful, and friendly. When suggesting commands or code, use markdown code blocks.'

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

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const body = await request.json()
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

    // Call LLM
    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: history,
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

    const decoded = verifyToken(token)
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
