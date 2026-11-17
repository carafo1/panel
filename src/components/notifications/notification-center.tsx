'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '@/store/auth-store'
import { useAuthStore } from '@/store/auth-store'
import { joinUserRoom, leaveUserRoom, type NotificationData } from '@/lib/socket'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Bell,
  BellOff,
  Info,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Trash2,
  CheckCheck,
} from 'lucide-react'

interface Notification {
  id: string
  title: string
  message: string
  type: string
  read: boolean
  link?: string
  createdAt: string
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

function getTypeIcon(type: string) {
  switch (type) {
    case 'info':
      return <Info className="size-4 text-indigo-500 shrink-0" />
    case 'success':
      return <CheckCircle2 className="size-4 text-indigo-500 shrink-0" />
    case 'warning':
      return <AlertTriangle className="size-4 text-amber-500 shrink-0" />
    case 'error':
      return <AlertCircle className="size-4 text-red-500 shrink-0" />
    default:
      return <Info className="size-4 text-indigo-500 shrink-0" />
  }
}

export function NotificationCenter() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const { user } = useAuthStore()
  const userIdRef = useRef<string | null>(null)

  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true)
      const data = await apiFetch('/notifications')
      setNotifications(data.notifications || [])
      setUnreadCount(data.unreadCount || 0)
    } catch {
      // Silently handle
    } finally {
      setLoading(false)
    }
  }, [])

  // Socket.io: handle incoming real-time notification
  const handleSocketNotification = useCallback((data: NotificationData) => {
    // Prepend the new notification to the list
    const newNotification: Notification = {
      id: `socket-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      title: data.title,
      message: data.message,
      type: data.type,
      read: false,
      createdAt: new Date().toISOString(),
    }

    setNotifications((prev) => [newNotification, ...prev])
    setUnreadCount((prev) => prev + 1)

    // Show a toast for the new notification
    toast(data.title, {
      description: data.message,
    })
  }, [])

  // Join/leave Socket.io user room when auth state changes
  useEffect(() => {
    const currentUserId = user?.id || null

    // Leave previous room if user changed
    if (userIdRef.current && userIdRef.current !== currentUserId) {
      leaveUserRoom(userIdRef.current)
    }

    // Join new room if authenticated
    if (currentUserId) {
      joinUserRoom(currentUserId, handleSocketNotification)
    }

    userIdRef.current = currentUserId

    return () => {
      // Leave room on unmount
      if (userIdRef.current) {
        leaveUserRoom(userIdRef.current)
        userIdRef.current = null
      }
    }
  }, [user?.id, handleSocketNotification])

  // Fetch notifications on mount + fallback polling every 60s
  useEffect(() => {
    fetchNotifications()
    // Poll every 60 seconds as fallback (increased from 30s)
    const interval = setInterval(fetchNotifications, 60000)
    return () => clearInterval(interval)
  }, [fetchNotifications])

  // Refetch when popover opens
  useEffect(() => {
    if (open) {
      fetchNotifications()
    }
  }, [open, fetchNotifications])

  const handleMarkAllRead = async () => {
    try {
      await apiFetch('/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ markAll: true }),
      })
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, read: true }))
      )
      setUnreadCount(0)
      toast.success('All notifications marked as read')
    } catch {
      toast.error('Failed to mark notifications as read')
    }
  }

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await apiFetch(`/notifications/${id}`, { method: 'DELETE' })
      setNotifications((prev) => prev.filter((n) => n.id !== id))
      setUnreadCount((prev) => {
        const notification = notifications.find((n) => n.id === id)
        return notification && !notification.read ? prev - 1 : prev
      })
      toast.success('Notification deleted')
    } catch {
      toast.error('Failed to delete notification')
    }
  }

  const handleClickNotification = async (notification: Notification) => {
    // Mark as read if unread
    if (!notification.read) {
      try {
        await apiFetch('/notifications/read', {
          method: 'POST',
          body: JSON.stringify({ notificationIds: [notification.id] }),
        })
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === notification.id ? { ...n, read: true } : n
          )
        )
        setUnreadCount((prev) => Math.max(0, prev - 1))
      } catch {
        // Silently handle
      }
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="size-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -end-0.5 min-w-[18px] h-[18px] rounded-full bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center px-1">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 sm:w-96 p-0"
        align="end"
        sideOffset={8}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold text-sm">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1"
              onClick={handleMarkAllRead}
            >
              <CheckCheck className="size-3.5" />
              Mark all read
            </Button>
          )}
        </div>

        {/* Notification list */}
        <div className="max-h-96 overflow-y-auto">
          {loading && notifications.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="size-6 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2">
              <BellOff className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No notifications</p>
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer group"
                  onClick={() => handleClickNotification(notification)}
                >
                  {/* Unread indicator */}
                  <div className="pt-0.5 shrink-0">
                    {!notification.read ? (
                      <span className="block size-2 rounded-full bg-orange-500" />
                    ) : (
                      <span className="block size-2" />
                    )}
                  </div>

                  {/* Icon */}
                  <div className="pt-0.5">
                    {getTypeIcon(notification.type)}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm leading-tight ${!notification.read ? 'font-semibold' : 'font-medium text-muted-foreground'}`}>
                      {notification.title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-tight line-clamp-2">
                      {notification.message}
                    </p>
                    <p className="text-[10px] text-muted-foreground/70 mt-1">
                      {formatRelativeTime(notification.createdAt)}
                    </p>
                  </div>

                  {/* Delete button */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-500"
                    onClick={(e) => handleDelete(notification.id, e)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {notifications.length >= 10 && (
          <div className="border-t px-4 py-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs text-muted-foreground hover:text-foreground"
            >
              View all notifications
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
