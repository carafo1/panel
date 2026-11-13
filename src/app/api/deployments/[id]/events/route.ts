import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'

/**
 * GET /api/deployments/[id]/events — Server-Sent Events stream of a
 * deployment's real state, polled from the database every 2 seconds until it
 * reaches a terminal status.
 *
 * This route used to *drive* a queued deployment itself: watching one moved
 * it through invented "building"/"deploying" logs to 'live' with a made-up
 * duration, whether or not anything was built. It now only reports what the
 * deployer has written.
 *
 * Auth: Authorization header, or `?token=` — the browser's EventSource cannot
 * set headers, and the panel's SSE fallback sends the token that way, so it
 * was always rejected with 401.
 */
const TERMINAL = new Set(['live', 'failed', 'rolled_back', 'cancelled'])
const POLL_MS = 2000
const MAX_STREAM_MS = 30 * 60 * 1000

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const token =
    extractTokenFromHeader(request.headers.get('Authorization')) ||
    new URL(request.url).searchParams.get('token')
  if (!token) return json(401, { error: 'Authorization token required' })

  const decoded = await verifyTokenFresh(token)
  if (!decoded) return json(401, { error: 'Invalid or expired token' })

  const { id } = await params
  const exists = await db.deployment.findUnique({
    where: { id },
    select: { id: true, projectId: true },
  })
  if (!exists) return json(404, { error: 'Deployment not found' })

  // Access is checked once, when the stream opens; the poll below reads the
  // row by id only.
  const access = await requireProjectAccess(decoded, exists.projectId, 'view')
  if (!access.ok) return access.response

  const encoder = new TextEncoder()
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const stream = new ReadableStream({
    start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        if (timer) clearTimeout(timer)
        try {
          controller.close()
        } catch {
          /* already closed by the client */
        }
      }
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk))
      }

      // Stop polling the database as soon as the viewer goes away.
      request.signal.addEventListener('abort', close)

      const poll = async () => {
        if (closed) return
        try {
          const current = await db.deployment.findUnique({
            where: { id },
            select: {
              id: true,
              status: true,
              buildLog: true,
              deployUrl: true,
              duration: true,
              updatedAt: true,
            },
          })
          if (!current) {
            send(`data: ${JSON.stringify({ error: 'Deployment not found' })}\n\n`)
            return close()
          }
          send(`data: ${JSON.stringify(current)}\n\n`)
          if (TERMINAL.has(current.status) || Date.now() - startedAt > MAX_STREAM_MS) {
            return close()
          }
          timer = setTimeout(poll, POLL_MS)
        } catch (error) {
          console.error('[deployments/events] poll failed:', error)
          send(': error\n\n')
          close()
        }
      }

      send(': connected\n\n')
      void poll()
    },
    cancel() {
      closed = true
      if (timer) clearTimeout(timer)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
