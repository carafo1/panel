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

/**
 * Push an event to a room. Room access is enforced when a browser JOINS
 * (/api/realtime/authorize), so only call this with rooms that check is
 * written for.
 */
export async function broadcastToRoom(room: string, event: string, data: unknown): Promise<void> {
  await broadcast(room, event, data)
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

/**
 * Stream one line of import progress to everyone watching this migration.
 *
 * Migrations run for minutes and the dashboard is the only place a customer
 * can see what is happening, so the log is pushed live rather than polled —
 * a 30-second poll on a stage that takes 30 seconds shows nothing at all.
 */
export function broadcastMigrationLog(migrationId: string, line: string): void {
  void broadcast(`migration:${migrationId}`, 'migration:log', {
    migrationId,
    line,
    timestamp: new Date().toISOString(),
  })
}

/** Broadcast a migration stage/status transition with its progress percentage. */
export function broadcastMigrationStatus(
  migrationId: string,
  projectId: string,
  status: string,
  progress: number,
  stage?: string,
  url?: string
): void {
  const data = { migrationId, projectId, status, progress, stage, url }
  void broadcast(`migration:${migrationId}`, 'migration:status', data)
  void broadcast(`project:${projectId}`, 'migration:status', data)
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
