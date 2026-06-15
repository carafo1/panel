import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authHeader = request.headers.get('Authorization')
  const token = extractTokenFromHeader(authHeader)

  if (!token) {
    return new Response(JSON.stringify({ error: 'Authorization token required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const decoded = verifyToken(token)
  if (!decoded) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { id } = await params

  // Verify the deployment exists and belongs to the user
  const deployment = await db.deployment.findFirst({
    where: { id, userId: decoded.userId },
  })

  if (!deployment) {
    return new Response(JSON.stringify({ error: 'Deployment not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const sendData = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      const sendComment = (comment: string) => {
        controller.enqueue(encoder.encode(`: ${comment}\n\n`))
      }

      // Simulated build log lines for demo
      const buildLogLines = [
        '📦 Cloning repository...',
        '📦 Installing dependencies...',
        '📦 Building application...',
        '📦 Optimizing production bundle...',
        '📦 Running linting checks...',
        '🚀 Starting deployment...',
        '🚀 Configuring server...',
        '🚀 Setting up SSL...',
        '🚀 Running health checks...',
        '✅ Deployment complete!',
      ]

      const terminalStatuses = ['live', 'failed', 'rolled_back']
      let simulationStarted = false

      const poll = async () => {
        try {
          const current = await db.deployment.findFirst({
            where: { id, userId: decoded.userId },
          })

          if (!current) {
            sendData({ error: 'Deployment not found' })
            controller.close()
            return
          }

          // For demo: simulate progress if deployment is still "queued"
          if (current.status === 'queued' && !simulationStarted) {
            simulationStarted = true

            // Kick off simulated progression in the background
            const simulateProgress = async () => {
              try {
                // Move to "building" after a short delay
                await sleep(2000)
                await db.deployment.update({
                  where: { id },
                  data: {
                    status: 'building',
                    buildLog: '📦 Cloning repository...\n📦 Installing dependencies...',
                  },
                })

                // Add build log lines progressively
                for (let i = 2; i < 6; i++) {
                  await sleep(2000)
                  const logs = buildLogLines.slice(0, i + 1).join('\n')
                  await db.deployment.update({
                    where: { id },
                    data: { buildLog: logs },
                  })
                }

                // Move to "deploying"
                await sleep(2000)
                await db.deployment.update({
                  where: { id },
                  data: {
                    status: 'deploying',
                    buildLog: buildLogLines.slice(0, 7).join('\n'),
                  },
                })

                // More deploy logs
                for (let i = 7; i < 9; i++) {
                  await sleep(2000)
                  const logs = buildLogLines.slice(0, i + 1).join('\n')
                  await db.deployment.update({
                    where: { id },
                    data: { buildLog: logs },
                  })
                }

                // Move to "live"
                await sleep(2000)
                const project = await db.project.findUnique({
                  where: { id: current.projectId },
                })
                const deployUrl = project?.subdomain
                  ? `https://${project.subdomain}.deployhub.io`
                  : `https://${current.projectId}.deployhub.io`

                await db.deployment.update({
                  where: { id },
                  data: {
                    status: 'live',
                    buildLog: buildLogLines.join('\n'),
                    deployUrl,
                    duration: 45,
                  },
                })
              } catch (err) {
                console.error('Simulation error:', err)
              }
            }

            simulateProgress()
          }

          // Send current state
          sendData({
            id: current.id,
            status: current.status,
            buildLog: current.buildLog,
            deployUrl: current.deployUrl,
            duration: current.duration,
            updatedAt: current.updatedAt,
          })

          // If terminal status, close the stream
          if (terminalStatuses.includes(current.status)) {
            controller.close()
            return
          }

          // Schedule next poll
          setTimeout(poll, 2000)
        } catch (error) {
          console.error('SSE poll error:', error)
          sendComment('error')
          controller.close()
        }
      }

      // Send initial comment to establish connection
      sendComment('connected')

      // Start polling
      poll()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
