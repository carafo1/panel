import { create } from 'zustand'

export interface User {
  id: string
  email: string
  name: string
  role: string
  emailVerified: boolean
  avatar?: string
  twoFactorEnabled?: boolean
  /** Set while a super admin is using support access as this user. */
  supportSession?: { adminEmail: string | null } | null
}

/** Result returned by `login`. Either a fully-authed user or a 2FA challenge. */
export type LoginResult =
  | { requiresTwoFactor: false; user: User }
  | { requiresTwoFactor: true; tempToken: string }

/**
 * SESSIONS: the login token lives in an httpOnly cookie set by the server
 * (src/lib/session.ts). Page scripts never see it, so an XSS bug cannot steal
 * it. Requests simply go to /api on the same origin and the browser attaches
 * the cookie. Nothing here stores or sends a token.
 */
interface AuthState {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (email: string, password: string) => Promise<LoginResult>
  completeTwoFactorLogin: (tempToken: string, token: string) => Promise<void>
  loginWithBackupCode: (tempToken: string, backupCode: string) => Promise<void>
  register: (name: string, email: string, password: string) => Promise<{ message: string }>
  logout: () => Promise<void>
  loadUser: () => Promise<void>
  setAuth: (user: User) => void
  verifyEmail: (token: string) => Promise<void>
  markEmailVerified: () => void
}

const API_BASE = '/api'

/** Where tokens were kept before sessions moved into a cookie. */
const LEGACY_TOKEN_KEYS = ['apsamo_token', 'deployhub_token']

/**
 * One-time upgrade: a browser that signed in before the change still has its
 * token in localStorage. Trade it for the session cookie, then delete it.
 */
async function upgradeLegacySession(): Promise<void> {
  if (typeof window === 'undefined') return
  let legacy: string | null = null
  try {
    for (const key of LEGACY_TOKEN_KEYS) legacy = legacy || localStorage.getItem(key)
    for (const key of LEGACY_TOKEN_KEYS) localStorage.removeItem(key)
  } catch {
    return // storage unavailable
  }
  if (!legacy) return
  await fetch(`${API_BASE}/auth/session`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Authorization: `Bearer ${legacy}` },
  }).catch(() => {})
}

function forgetLegacyTokens(): void {
  try {
    for (const key of LEGACY_TOKEN_KEYS) localStorage.removeItem(key)
  } catch {
    /* storage unavailable */
  }
}

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
export async function apiFetch<T = any>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
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
  isLoading: true,
  isAuthenticated: false,

  setAuth: (user) => {
    set({ user, isAuthenticated: true, isLoading: false })
  },

  login: async (email, password) => {
    const data = await apiFetch<{
      requiresTwoFactor?: boolean
      tempToken?: string
      user: User
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
    // The session cookie came back with this response.
    get().setAuth(data.user)
    return { requiresTwoFactor: false, user: data.user }
  },

  completeTwoFactorLogin: async (tempToken, token) => {
    const data = await apiFetch<{ user: User }>('/auth/2fa/login-verify', {
      method: 'POST',
      body: JSON.stringify({ tempToken, token }),
    })
    get().setAuth(data.user)
  },

  // A backup code replaces the 6-digit code, not the password: it needs the
  // tempToken from the password step, exactly like completeTwoFactorLogin.
  loginWithBackupCode: async (tempToken, backupCode) => {
    const data = await apiFetch<{ user: User }>('/auth/2fa/verify-backup', {
      method: 'POST',
      body: JSON.stringify({ tempToken, backupCode }),
    })
    get().setAuth(data.user)
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
    // The server cleared the cookie; also drop any pre-cookie token.
    forgetLegacyTokens()
    set({ user: null, isAuthenticated: false, isLoading: false })
  },

  loadUser: async () => {
    await upgradeLegacySession()
    try {
      const data = await apiFetch<{ user: User }>('/auth/me')
      set({ user: data.user, isAuthenticated: true, isLoading: false })
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false })
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
