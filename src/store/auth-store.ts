import { create } from 'zustand'

export interface User {
  id: string
  email: string
  name: string
  role: string
  emailVerified: boolean
  avatar?: string
  twoFactorEnabled?: boolean
}

/** Result returned by `login`. Either a fully-authed user or a 2FA challenge. */
export type LoginResult =
  | { requiresTwoFactor: false; user: User; token: string }
  | { requiresTwoFactor: true; tempToken: string }

interface AuthState {
  user: User | null
  token: string | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (email: string, password: string) => Promise<LoginResult>
  completeTwoFactorLogin: (tempToken: string, token: string) => Promise<void>
  loginWithBackupCode: (email: string, backupCode: string) => Promise<void>
  register: (name: string, email: string, password: string) => Promise<{ message: string }>
  logout: () => Promise<void>
  loadUser: () => Promise<void>
  setAuth: (user: User, token: string) => void
  verifyEmail: (token: string) => Promise<void>
  markEmailVerified: () => void
}

const API_BASE = '/api'

/**
 * Authenticated fetch against the API.
 *
 * Generic so callers can name their response shape (`apiFetch<Plan[]>(…)`)
 * instead of each panel re-wrapping this in its own typed helper.
 */
// Defaults to `any`, not `unknown`: this previously returned an implicit
// `any` and ~70 call sites across the panels destructure the result directly.
// Defaulting to `unknown` would be stricter but breaks all of them at once;
// callers should pass an explicit type argument as they get touched.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiFetch<T = any>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('apsamo_token') : null
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
  return res.json() as Promise<T>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isLoading: true,
  isAuthenticated: false,

  setAuth: (user, token) => {
    localStorage.setItem('apsamo_token', token)
    set({ user, token, isAuthenticated: true, isLoading: false })
  },

  login: async (email, password) => {
    const data = await apiFetch<{
      requiresTwoFactor?: boolean
      tempToken?: string
      user: User
      token: string
    }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    // 2FA gate: if the user has 2FA enabled, the API returns a tempToken
    // instead of a session. The caller (UI) is responsible for prompting
    // for the second factor via completeTwoFactorLogin() or
    // loginWithBackupCode().
    if (data.requiresTwoFactor) {
      return { requiresTwoFactor: true, tempToken: data.tempToken! }
    }
    get().setAuth(data.user, data.token)
    return { requiresTwoFactor: false, user: data.user, token: data.token }
  },

  completeTwoFactorLogin: async (tempToken, token) => {
    const data = await apiFetch<{ user: User; token: string }>('/auth/2fa/login-verify', {
      method: 'POST',
      body: JSON.stringify({ tempToken, token }),
    })
    get().setAuth(data.user, data.token)
  },

  loginWithBackupCode: async (email, backupCode) => {
    const data = await apiFetch<{ user: User; token: string }>('/auth/2fa/verify-backup', {
      method: 'POST',
      body: JSON.stringify({ email, backupCode }),
    })
    get().setAuth(data.user, data.token)
  },

  register: async (name, email, password) => {
    const data = await apiFetch<{ message: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    })
    // Registration now requires email verification before login.
    // The API returns `{ message: "..." }` only - no session token -
    // so we do NOT call setAuth here. The user must click the
    // verification link in their email, then sign in normally.
    return data as { message: string }
  },

  logout: async () => {
    // Fire-and-forget audit log on the server (best-effort - never blocks UI).
    try {
      await apiFetch('/auth/logout', { method: 'POST' })
    } catch {
      // ignore - logout must succeed client-side even if API call fails
    }
    localStorage.removeItem('apsamo_token')
    set({ user: null, token: null, isAuthenticated: false, isLoading: false })
  },

  loadUser: async () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('apsamo_token') : null
    if (!token) {
      set({ isLoading: false })
      return
    }
    try {
      const data = await apiFetch<{ user: User }>('/auth/me')
      set({ user: data.user, token, isAuthenticated: true, isLoading: false })
    } catch {
      localStorage.removeItem('apsamo_token')
      set({ user: null, token: null, isAuthenticated: false, isLoading: false })
    }
  },

  verifyEmail: async (verificationToken: string) => {
    const data = await apiFetch<{ success?: boolean }>(
      `/auth/verify-email?token=${verificationToken}`
    )
    if (data.success) {
      set((state) => ({
        user: state.user ? { ...state.user, emailVerified: true } : state.user,
      }))
    }
  },

  markEmailVerified: () => {
    set((state) => ({
      user: state.user ? { ...state.user, emailVerified: true } : state.user,
    }))
  },
}))
