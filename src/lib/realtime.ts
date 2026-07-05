/**
 * Server-side bridge to the realtime (Socket.IO) mini-service.
 *
 * The realtime service (mini-services/realtime-service) exposes an internal
 * broadcast endpoint on port 3004:
 *
 *   POST /api/broadcast  { room, event, data }  ->  io.to(room).emit(event, data)
 *
 * These helpers push REAL deployment progress (log lines + status transitions)
 * to that endpoint so the dashboard streams actual build output instead of a
 * simulation. Every call is fire-and-forget: a realtime outage (service down,
 * network blip) must never block or fail a deployment.
 *
 * Room / event contract must match src/lib/socket.ts (the browser client):
 *   room  `deployment:<id>`  event `deployment:log`    data { deploymentId, line, timestamp }
 *   room  `deployment:<id>`  event `deployment:status` data { deploymentId, projectId, status, url? }
 *   room  `project:<id>`     event `deployment:status` data { deploymentId, projectId, status, url? }
 */

const REALTIME_INTERNAL_URL =
  process.env.REALTIME_INTERNAL_URL || 'http://localhost:3004'

async function broadcast(room: string, event: string, data: unknown): Promise<void> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    await fetch(`${REALTIME_INTERNAL_URL}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, event, data }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
  } catch {
    // Realtime is best-effort — swallow so callers (e.g. the deployer) are unaffected.
  }
}

/** Stream one real log line to everyone watching this deployment. */
export function broadcastDeploymentLog(deploymentId: string, line: string): void {
  void broadcast(`deployment:${deploymentId}`, 'deployment:log', {
    deploymentId,
    line,
    timestamp: new Date().toISOString(),
  })
}

/** Broadcast a deployment status transition (queued/building/live/failed). */
export function broadcastDeploymentStatus(
  deploymentId: string,
  projectId: string,
  status: string,
  url?: string
): void {
  const data = { deploymentId, projectId, status, url }
  void broadcast(`deployment:${deploymentId}`, 'deployment:status', data)
  void broadcast(`project:${projectId}`, 'deployment:status', data)
}

/** Push a user-facing notification to a specific user's room. */
export function broadcastNotification(
  userId: string,
  title: string,
  message: string,
  type: string
): void {
  void broadcast(`user:${userId}`, 'notification', { userId, title, message, type })
}
