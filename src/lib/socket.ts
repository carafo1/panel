import { io, Socket } from 'socket.io-client'

// ── Socket.io client singleton ────────────────────────────────────────
let socket: Socket | null = null

function getSocketUrl(): string {
  // When accessed through Caddy gateway (port 81), use XTransformPort
  // When accessed directly (port 3000), try direct connection to socket.io server
  if (typeof window === 'undefined') return '/?XTransformPort=3003'
  const { port } = window.location
  // If accessing via Caddy gateway (port 81 or no port), use XTransformPort
  if (!port || port === '81') {
    return '/?XTransformPort=3003'
  }
  // Direct access - connect directly to the socket.io server on port 3003
  return `${window.location.protocol}//${window.location.hostname}:3003`
}

export function getSocket(): Socket {
  if (!socket) {
    const socketUrl = getSocketUrl()
    socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      forceNew: false,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 10000,
    })

    socket.on('connect', () => {
      console.log('[socket] Connected to realtime service')
    })

    socket.on('disconnect', (reason) => {
      console.log('[socket] Disconnected:', reason)
    })

    socket.on('connect_error', () => {
      // Silently handle - realtime features degrade gracefully to polling
    })
  }
  return socket
}

// ── Types ─────────────────────────────────────────────────────────────
export interface DeploymentLogData {
  deploymentId: string
  line: string
  timestamp: string
}

export interface DeploymentStatusData {
  deploymentId: string
  projectId: string
  status: string
  url?: string
}

export interface NotificationData {
  userId: string
  title: string
  message: string
  type: string
}

// ── Helper functions ──────────────────────────────────────────────────
export function joinDeploymentRoom(
  deploymentId: string,
  onLog: (data: DeploymentLogData) => void,
  onStatus: (data: DeploymentStatusData) => void
): Socket {
  const sock = getSocket()
  const room = `deployment:${deploymentId}`

  sock.emit('join-room', room)
  sock.on('deployment:log', onLog)
  sock.on('deployment:status', onStatus)

  return sock
}

export function leaveDeploymentRoom(deploymentId: string): void {
  const sock = getSocket()
  const room = `deployment:${deploymentId}`

  sock.emit('leave-room', room)
  sock.off('deployment:log')
  sock.off('deployment:status')
}

export function joinProjectRoom(
  projectId: string,
  onStatus: (data: DeploymentStatusData) => void
): Socket {
  const sock = getSocket()
  const room = `project:${projectId}`

  sock.emit('join-room', room)
  sock.on('deployment:status', onStatus)

  return sock
}

export function leaveProjectRoom(projectId: string): void {
  const sock = getSocket()
  const room = `project:${projectId}`

  sock.emit('leave-room', room)
  sock.off('deployment:status')
}

export function joinUserRoom(
  userId: string,
  onNotification: (data: NotificationData) => void
): Socket {
  const sock = getSocket()
  const room = `user:${userId}`

  sock.emit('join-room', room)
  sock.on('notification', onNotification)

  return sock
}

export function leaveUserRoom(userId: string): void {
  const sock = getSocket()
  const room = `user:${userId}`

  sock.emit('leave-room', room)
  sock.off('notification')
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect()
    socket = null
  }
}
