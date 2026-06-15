import { create } from 'zustand'

export interface User {
  id: string
  email: string
  name: string
  role: string
  emailVerified: boolean
  avatar?: string
}

interface AuthState {
  user: User | null
  token: string | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (email: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string) => Promise<void>
  logout: () => void
  loadUser: () => Promise<void>
  setAuth: (user: User, token: string) => void
}

const API_BASE = '/api'

async function apiFetch(path: string, options?: RequestInit) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('deployhub_token') : null
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(data.error || `Request failed with status ${res.status}`)
  }
  return res.json()
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isLoading: true,
  isAuthenticated: false,

  setAuth: (user, token) => {
    localStorage.setItem('deployhub_token', token)
    set({ user, token, isAuthenticated: true, isLoading: false })
  },

  login: async (email, password) => {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    get().setAuth(data.user, data.token)
  },

  register: async (name, email, password) => {
    const data = await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    })
    get().setAuth(data.user, data.token)
  },

  logout: () => {
    localStorage.removeItem('deployhub_token')
    set({ user: null, token: null, isAuthenticated: false, isLoading: false })
  },

  loadUser: async () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('deployhub_token') : null
    if (!token) {
      set({ isLoading: false })
      return
    }
    try {
      const data = await apiFetch('/auth/me')
      set({ user: data.user, token, isAuthenticated: true, isLoading: false })
    } catch {
      localStorage.removeItem('deployhub_token')
      set({ user: null, token: null, isAuthenticated: false, isLoading: false })
    }
  },
}))

export { apiFetch }
