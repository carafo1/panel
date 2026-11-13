/**
 * Apsamo Panel — Realtime service (Socket.IO)
 *
 *   • Port 3003 — Socket.IO server the browser connects to. Clients join rooms
 *     (`deployment:<id>`, `project:<id>`, `user:<id>`) and receive events.
 *   • Port 3004 — internal broadcast API. The Next.js app POSTs REAL events
 *     here and we relay them to the matching Socket.IO room:
 *
 *         POST /api/broadcast  { room, event, data }  ->  io.to(room).emit(event, data)
 *
 * This service is a pure relay: it holds no deployment logic and generates no
 * content of its own. All deployment logs + status transitions are produced by
 * the deployer (src/lib/vps/deployer.ts) and pushed here via src/lib/realtime.ts.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Server, Socket } from 'socket.io'

// ── Socket.io server (port 3003) ──────────────────────────────────────
const httpServer = createServer()
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// Health + fallback HTTP on port 3003. Socket.io only handles /socket.io/*
// requests, so everything else falls through to this handler.
httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
  if (req.url?.startsWith('/socket.io')) {
    return
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'realtime-service',
        uptime: process.uptime(),
        connections: io.sockets.sockets.size,
        timestamp: new Date().toISOString(),
      })
    )
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

// ── Internal broadcast API (port 3004) ────────────────────────────────
const internalServer = createServer(
  (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'POST' && req.url?.startsWith('/api/broadcast')) {
      let body = ''
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        try {
          const { room, event, data } = JSON.parse(body)
          if (room && event) {
            io.to(room).emit(event, data)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, room, event }))
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({ error: 'Missing required fields: room, event' })
            )
          }
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
        }
      })
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'realtime-service-internal',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        })
      )
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }
)

// ── Authorization ─────────────────────────────────────────────────────
// Rooms carry live build logs (which can contain secrets), import progress
// and per-user notifications. Anyone could join any room, so knowing an id
// was enough to read another customer's logs. Now:
//   1. a connection must present the user's login token (handshake.auth.token)
//   2. every join is checked by the panel (/api/realtime/authorize), which
//      applies the same project/team rules as the REST API
// The token is forwarded, never interpreted here: no JWT secret or database
// access lives in this service.
const PANEL_API_BASE = process.env.NEXT_API_BASE || 'http://127.0.0.1:3000'
const AUTHORIZE_TIMEOUT_MS = 5000

async function authorizeRoom(
  token: string,
  room: string
): Promise<{ ok: boolean; status: number; userId?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AUTHORIZE_TIMEOUT_MS)
  try {
    const res = await fetch(`${PANEL_API_BASE}/api/realtime/authorize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ room }),
      signal: controller.signal,
    })
    const body = (await res.json().catch(() => ({}))) as { userId?: string }
    return { ok: res.ok, status: res.status, userId: body.userId }
  } catch {
    // Panel unreachable: fail closed.
    return { ok: false, status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

function tokenOf(socket: Socket): string | null {
  const t = (socket.handshake.auth as { token?: unknown } | undefined)?.token
  return typeof t === 'string' && t.length > 0 && t.length < 4096 ? t : null
}

// Refuse connections without a token up front; the token itself is checked
// on every join (so expiry, logout and role changes apply immediately).
io.use((socket, next) => {
  if (!tokenOf(socket)) return next(new Error('unauthorized'))
  next()
})

// ── Socket.io connection handling ─────────────────────────────────────
io.on('connection', (socket: Socket) => {
  console.log(
    `[realtime] Client connected: ${socket.id} (total: ${io.sockets.sockets.size})`
  )

  socket.on('join-room', async (room: unknown) => {
    if (typeof room !== 'string' || room.length > 100) return
    const token = tokenOf(socket)
    const verdict = token ? await authorizeRoom(token, room) : { ok: false, status: 401 }
    if (!verdict.ok) {
      socket.emit('room-denied', { room, status: verdict.status })
      console.warn(`[realtime] ${socket.id} denied room ${room} (${verdict.status})`)
      if (verdict.status === 401) socket.disconnect(true)
      return
    }
    socket.join(room)
    console.log(`[realtime] ${socket.id} joined room: ${room}`)
  })

  socket.on('leave-room', (room: string) => {
    socket.leave(room)
    console.log(`[realtime] ${socket.id} left room: ${room}`)
  })

  socket.on('disconnect', (reason) => {
    console.log(
      `[realtime] Client disconnected: ${socket.id} (${reason}) (total: ${io.sockets.sockets.size})`
    )
  })

  socket.on('error', (error) => {
    console.error(`[realtime] Socket error (${socket.id}):`, error)
  })
})

// ── Start servers ─────────────────────────────────────────────────────
const SOCKET_PORT = 3003
const INTERNAL_PORT = 3004
// Bind to loopback by default: Caddy proxies the browser to :3003 and the
// Next.js app POSTs to :3004 — both from this same host. The internal broadcast
// API is unauthenticated, so it must never listen on a public interface.
// (Overridable via REALTIME_HOST for split-host topologies behind a firewall.)
const HOST = process.env.REALTIME_HOST || '127.0.0.1'

httpServer.listen(SOCKET_PORT, HOST, () => {
  console.log(`[realtime] Socket.IO server running on ${HOST}:${SOCKET_PORT}`)
  console.log(`[realtime] Health check: GET http://${HOST}:${SOCKET_PORT}/health`)
})

internalServer.listen(INTERNAL_PORT, HOST, () => {
  console.log(`[realtime] Internal broadcast API on ${HOST}:${INTERNAL_PORT}`)
  console.log(
    `[realtime] Broadcast endpoint: POST http://${HOST}:${INTERNAL_PORT}/api/broadcast`
  )
})

// ── Graceful shutdown ─────────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`[realtime] Received ${signal}, shutting down...`)
  io.close(() => {
    httpServer.close(() => {
      internalServer.close(() => {
        console.log('[realtime] All servers closed')
        process.exit(0)
      })
    })
  })
  setTimeout(() => {
    console.error('[realtime] Forced shutdown after timeout')
    process.exit(1)
  }, 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
