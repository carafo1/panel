import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Server, Socket } from 'socket.io'

// ── Types ──────────────────────────────────────────────────────────────
interface DeploymentLogData {
  deploymentId: string
  line: string
  timestamp: string
}

interface DeploymentStatusData {
  deploymentId: string
  projectId: string
  status: string
  url?: string
}

interface NotificationData {
  userId: string
  title: string
  message: string
  type: string
}

interface DeploymentState {
  status: 'queued' | 'building' | 'deploying' | 'live' | 'failed'
  projectId: string
  startedAt: number
  timers: ReturnType<typeof setTimeout>[]
}

// ── Socket.io Server (Port 3003) ──────────────────────────────────────
const httpServer = createServer()
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ── Deployment Simulation State ────────────────────────────────────────
const deploymentStates = new Map<string, DeploymentState>()

// ── Health Check + Fallback HTTP on port 3003 ─────────────────────────
// We must attach our handler BEFORE socket.io processes the request.
// Socket.io only handles /socket.io/* paths, so other paths fall through.
httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
  // Let socket.io handle its own protocol requests
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
        activeDeployments: deploymentStates.size,
        timestamp: new Date().toISOString(),
      })
    )
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

// ── Internal API Server (Port 3004) ───────────────────────────────────
const internalServer = createServer(
  (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for internal API
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
            console.log(
              `[broadcast] Room="${room}" Event="${event}" Data=${JSON.stringify(data).slice(0, 120)}`
            )
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

// ── Simulated Deployment Engine ────────────────────────────────────────

function clearDeploymentTimers(deploymentId: string) {
  const state = deploymentStates.get(deploymentId)
  if (state) {
    state.timers.forEach((t) => clearTimeout(t))
    state.timers = []
  }
}

function emitStatus(
  deploymentId: string,
  projectId: string,
  status: string,
  url?: string
) {
  const data: DeploymentStatusData = { deploymentId, projectId, status, url }
  io.to(`deployment:${deploymentId}`).emit('deployment:status', data)
  io.to(`project:${projectId}`).emit('deployment:status', data)
  console.log(
    `[deployment] ${deploymentId.slice(0, 8)} status → ${status}${url ? ` (${url})` : ''}`
  )
}

function emitLog(deploymentId: string, line: string) {
  const data: DeploymentLogData = {
    deploymentId,
    line,
    timestamp: new Date().toISOString(),
  }
  io.to(`deployment:${deploymentId}`).emit('deployment:log', data)
}

function emitNotification(
  userId: string,
  title: string,
  message: string,
  type: string
) {
  const data: NotificationData = { userId, title, message, type }
  io.to(`user:${userId}`).emit('notification', data)
  console.log(`[notification] user:${userId} → ${title}`)
}

// Realistic build log lines - mirror the actual shell commands Coolify
// runs when building a Nixpacks/Docker application. The leading `$ ` makes
// it visually obvious these are shell commands, just like a real CI log.
const BUILD_LOG_LINES = [
  { line: '🚀 DeployHub Build Pipeline v2.4.0', delay: 300 },
  { line: '────────────────────────────────────────', delay: 200 },
  { line: '$ git clone --depth 1 https://github.com/deployhub/app.git .', delay: 600 },
  { line: 'Cloning into \'.\'...', delay: 500 },
  { line: 'remote: Enumerating objects: 412, done.', delay: 300 },
  { line: 'remote: Counting objects: 100% (412/412), done.', delay: 400 },
  { line: 'remote: Compressing objects: 100% (218/218), done.', delay: 400 },
  { line: 'Receiving objects: 100% (412/412), 1.84 MiB | 6.2 MiB/s, done.', delay: 500 },
  { line: 'Resolving deltas: 100% (186/186), done.', delay: 300 },
  { line: '✓ Repository cloned (commit a1b2c3d)', delay: 300 },
  { line: '', delay: 100 },
  { line: '$ detecting framework...', delay: 400 },
  { line: '✓ Detected: Next.js 16 (App Router)', delay: 300 },
  { line: '$ reading package.json', delay: 300 },
  { line: '  → next@16.1.1  react@19.0.0  typescript@5.x', delay: 300 },
  { line: '', delay: 100 },
  { line: '$ npm install --no-audit --no-fund', delay: 400 },
  { line: 'npm WARN deprecated some-pkg@1.0.0: use newer-pkg instead', delay: 400 },
  { line: 'added 342 packages, and audited 343 packages in 8s', delay: 1200 },
  { line: 'found 0 vulnerabilities', delay: 300 },
  { line: '✓ Dependencies installed (342 packages)', delay: 300 },
  { line: '', delay: 100 },
  { line: '$ npm run build', delay: 500 },
  { line: '> deployhub-app@1.0.0 build', delay: 300 },
  { line: '> next build', delay: 300 },
  { line: '  ▲ Next.js 16.1.1', delay: 500 },
  { line: '  - Environments: .env.production', delay: 400 },
  { line: '  - Creating an optimized production build...', delay: 800 },
  { line: '  ✓ Compiled successfully', delay: 1500 },
  { line: '  - Collecting page data...', delay: 600 },
  { line: '  - Generating static pages (6/12)...', delay: 500 },
  { line: '  - Generating static pages (12/12)...', delay: 700 },
  { line: '  ✓ Static pages generated', delay: 300 },
  { line: '  - Finalizing page optimization...', delay: 500 },
  { line: '  Route (app)                    Size     First Load JS', delay: 300 },
  { line: '  ┌ ○ /                          5.2 kB         89.1 kB', delay: 200 },
  { line: '  ├ ○ /dashboard                 3.8 kB         87.7 kB', delay: 200 },
  { line: '  ├ ƒ /api/health                0 B                N/A', delay: 200 },
  { line: '  └ ○ /projects                  4.1 kB         88.0 kB', delay: 200 },
  { line: '  First Load JS shared by all:  84.3 kB', delay: 300 },
  { line: '  ✓ Build completed in 12.4s', delay: 400 },
  { line: '', delay: 100 },
  { line: '$ docker build -t app-{id} .', delay: 500 },
  { line: '[+] Building 18.4s (12/12) FINISHED', delay: 600 },
  { line: ' => [internal] load build definition from Dockerfile', delay: 300 },
  { line: ' => [internal] load .dockerignore', delay: 300 },
  { line: ' => [base 1/5] FROM docker.io/library/node:20-alpine', delay: 500 },
  { line: ' => [deps 2/5] WORKDIR /app', delay: 300 },
  { line: ' => [deps 3/5] COPY package*.json ./', delay: 400 },
  { line: ' => [deps 4/5] RUN npm ci --omit=dev', delay: 1500 },
  { line: ' => [build 5/5] COPY . .', delay: 500 },
  { line: ' => exporting to image', delay: 500 },
  { line: ' => => writing image sha256:a1b2c3d4e5f6...', delay: 400 },
  { line: ' => => naming to docker.io/library/app-{id}', delay: 300 },
  { line: '✓ Docker image built (54.2 MB)', delay: 300 },
]

const DEPLOY_LOG_LINES = [
  { line: '', delay: 100 },
  { line: '🚀 Deploying to production server...', delay: 400 },
  { line: '$ docker run -d -p 8080:8080 --name app-{id} \\', delay: 400 },
  { line: '    --restart unless-stopped \\', delay: 200 },
  { line: '    -e NODE_ENV=production \\', delay: 200 },
  { line: '    -e PORT=8080 \\', delay: 200 },
  { line: '    app-{id}', delay: 400 },
  { line: 'a1b2c3d4e5f6789...container started', delay: 600 },
  { line: '✓ Container running (id: a1b2c3d4)', delay: 300 },
  { line: '', delay: 100 },
  { line: '🌐 Configuring reverse proxy (Traefik)...', delay: 500 },
  { line: '✓ Subdomain routed: {subdomain}', delay: 400 },
  { line: '🔒 Provisioning SSL certificate (Let\'s Encrypt)...', delay: 800 },
  { line: '  - Challenge type: HTTP-01', delay: 300 },
  { line: '  - Certificate issued', delay: 500 },
  { line: '✓ HTTPS enabled', delay: 300 },
  { line: '', delay: 100 },
  { line: '🏥 Running health checks...', delay: 500 },
  { line: 'GET https://{subdomain}/api/health → 200 OK (84ms)', delay: 600 },
  { line: '✓ Health check passed', delay: 300 },
  { line: '', delay: 100 },
  { line: '✅ Deployment successful at https://{subdomain}', delay: 400 },
]

const FAIL_LOG_LINES = [
  { line: '', delay: 100 },
  { line: '❌ Build step failed!', delay: 300 },
  { line: 'Error: Module not found: Cannot resolve "missing-module"', delay: 400 },
  { line: '    at ModuleResolver.resolve (/app/node_modules/next/dist/...)', delay: 200 },
  { line: '    at async Object.resolveRequest (/app/node_modules/next/dist/...)', delay: 200 },
  { line: '    at async next.config.js', delay: 200 },
  { line: '', delay: 100 },
  { line: '> Build failed with 1 error', delay: 300 },
  { line: '💡 Check your import statements and ensure all dependencies are installed.', delay: 400 },
  { line: '💡 Run `npm install missing-module` to add the missing package.', delay: 400 },
  { line: '', delay: 200 },
  { line: '❌ Deployment failed at https://{subdomain}', delay: 300 },
]

function simulateDeployment(deploymentId: string, projectId: string) {
  // If already simulating, don't restart
  if (deploymentStates.has(deploymentId)) {
    const existing = deploymentStates.get(deploymentId)!
    // Only restart if it's in a terminal state
    if (existing.status === 'live' || existing.status === 'failed') {
      clearDeploymentTimers(deploymentId)
      deploymentStates.delete(deploymentId)
    } else {
      console.log(
        `[deployment] ${deploymentId.slice(0, 8)} already in progress (${existing.status})`
      )
      return
    }
  }

  const startedAt = Date.now()
  const willFail = Math.random() < 0.1 // 10% chance of failure
  const failAtIndex = willFail
    ? Math.floor(Math.random() * (BUILD_LOG_LINES.length - 5)) + 5
    : -1

  // Derive a realistic subdomain + container id from the deployment/project
  // ids so the log lines (which contain {id} and {subdomain} placeholders)
  // read like a real Coolify build.
  const shortId = deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10) || 'app'
  const subdomain = `${shortId}.deployhub.io`
  const renderLine = (raw: string): string =>
    raw
      .replace(/\{id\}/g, shortId)
      .replace(/\{subdomain\}/g, subdomain)

  const state: DeploymentState = {
    status: 'queued',
    projectId,
    startedAt,
    timers: [],
  }
  deploymentStates.set(deploymentId, state)

  const addTimer = (fn: () => void, delay: number) => {
    const timer = setTimeout(fn, delay)
    state.timers.push(timer)
    return timer
  }

  const ts = () => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  // Emit initial queued status
  emitStatus(deploymentId, projectId, 'queued')

  // Start streaming logs after 1s
  let logIndex = 0

  const emitNextBuildLog = () => {
    if (logIndex >= BUILD_LOG_LINES.length || logIndex > failAtIndex) {
      // Build phase done (or failed)
      if (willFail && logIndex >= failAtIndex) {
        // Emit failure logs
        let failIndex = 0
        const emitNextFailLog = () => {
          if (failIndex >= FAIL_LOG_LINES.length) {
            // Mark as failed
            state.status = 'failed'
            emitStatus(deploymentId, projectId, 'failed')
            emitNotification(
              'user_1',
              'Deployment Failed',
              `Deployment ${deploymentId.slice(0, 8)} failed during build step.`,
              'error'
            )
            const duration = ((Date.now() - startedAt) / 1000).toFixed(1)
            emitLog(
              deploymentId,
              `${ts()} > ⏱️ Deployment failed after ${duration}s`
            )
            deploymentStates.delete(deploymentId)
            return
          }
          const item = FAIL_LOG_LINES[failIndex]
          emitLog(deploymentId, `${ts()} > ${renderLine(item.line)}`)
          failIndex++
          addTimer(emitNextFailLog, item.delay)
        }
        emitNextFailLog()
      } else {
        // Transition to building status
        state.status = 'building'
        emitStatus(deploymentId, projectId, 'building')
        emitLog(
          deploymentId,
          `${ts()} > ⏱️ Build phase completed, preparing for deployment...`
        )

        // After 2s, move to deploying
        addTimer(() => {
          state.status = 'deploying'
          emitStatus(deploymentId, projectId, 'deploying')

          // Stream deploy logs
          let deployIndex = 0
          const emitNextDeployLog = () => {
            if (deployIndex >= DEPLOY_LOG_LINES.length) {
              // Deployment complete!
              const deployUrl = `https://${subdomain}`
              state.status = 'live'
              emitStatus(deploymentId, projectId, 'live', deployUrl)

              const duration = ((Date.now() - startedAt) / 1000).toFixed(1)
              emitLog(
                deploymentId,
                `${ts()} > ✅ Deployment live at ${deployUrl} (${duration}s)`
              )
              emitNotification(
                'user_1',
                'Deployment Complete',
                `Deployment ${deploymentId.slice(0, 8)} is now live!`,
                'success'
              )
              deploymentStates.delete(deploymentId)
              return
            }
            const item = DEPLOY_LOG_LINES[deployIndex]
            emitLog(deploymentId, `${ts()} > ${renderLine(item.line)}`)
            deployIndex++
            addTimer(emitNextDeployLog, item.delay)
          }

          addTimer(emitNextDeployLog, 500)
        }, 2000)
      }
      return
    }

    const item = BUILD_LOG_LINES[logIndex]
    emitLog(deploymentId, `${ts()} > ${renderLine(item.line)}`)

    // Transition from queued → building after the first few lines
    if (logIndex === 3 && state.status === 'queued') {
      state.status = 'building'
      emitStatus(deploymentId, projectId, 'building')
    }

    logIndex++
    addTimer(emitNextBuildLog, item.delay)
  }

  addTimer(emitNextBuildLog, 1000)
}

// ── Socket.io Connection Handling ─────────────────────────────────────
io.on('connection', (socket: Socket) => {
  console.log(
    `[realtime] Client connected: ${socket.id} (total: ${io.sockets.sockets.size})`
  )

  // Handle join-room
  socket.on('join-room', (room: string) => {
    socket.join(room)
    console.log(`[realtime] ${socket.id} joined room: ${room}`)

    // If joining a deployment room, start simulation if not already running
    if (room.startsWith('deployment:')) {
      const deploymentId = room.replace('deployment:', '')
      // Derive projectId from deploymentId or use a default
      const projectId = deploymentId.split('-')[0] || 'proj_1'
      simulateDeployment(deploymentId, projectId)
    }
  })

  // Handle leave-room
  socket.on('leave-room', (room: string) => {
    socket.leave(room)
    console.log(`[realtime] ${socket.id} left room: ${room}`)
  })

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    console.log(
      `[realtime] Client disconnected: ${socket.id} (${reason}) (total: ${io.sockets.sockets.size})`
    )
  })

  // Handle errors
  socket.on('error', (error) => {
    console.error(`[realtime] Socket error (${socket.id}):`, error)
  })
})

// ── Start Servers ─────────────────────────────────────────────────────
const SOCKET_PORT = 3003
const INTERNAL_PORT = 3004

httpServer.listen(SOCKET_PORT, () => {
  console.log(
    `[realtime] DeployHub realtime service running on port ${SOCKET_PORT}`
  )
  console.log(`[realtime] Health check available at GET /health`)
})

internalServer.listen(INTERNAL_PORT, () => {
  console.log(
    `[realtime] Internal API running on port ${INTERNAL_PORT}`
  )
  console.log(
    `[realtime] Broadcast endpoint: POST http://localhost:${INTERNAL_PORT}/api/broadcast`
  )
})

// ── Graceful Shutdown ─────────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`[realtime] Received ${signal}, shutting down...`)

  // Clean up all deployment simulations
  deploymentStates.forEach((state, id) => {
    state.timers.forEach((t) => clearTimeout(t))
  })
  deploymentStates.clear()

  io.close(() => {
    httpServer.close(() => {
      internalServer.close(() => {
        console.log('[realtime] All servers closed')
        process.exit(0)
      })
    })
  })

  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => {
    console.error('[realtime] Forced shutdown after timeout')
    process.exit(1)
  }, 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
