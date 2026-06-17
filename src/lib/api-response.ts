/**
 * Standardized API response envelope used by every domain reseller endpoint.
 *
 * Every endpoint returns:
 * {
 *   "success": true,
 *   "message": "",
 *   "data": {},
 *   "errors": [],
 *   "timestamp": "",
 *   "requestId": ""
 * }
 */
import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'

export interface ApiEnvelope<T = unknown> {
  success: boolean
  message: string
  data: T | null
  errors: ApiError[]
  timestamp: string
  requestId: string
}

export interface ApiError {
  code: string
  message: string
  field?: string
}

/**
 * Build a success envelope.
 */
export function ok<T>(
  data: T,
  message = 'Operation completed successfully',
  status = 200
): NextResponse {
  return NextResponse.json<ApiEnvelope<T>>(
    {
      success: true,
      message,
      data,
      errors: [],
      timestamp: new Date().toISOString(),
      requestId: randomUUID(),
    },
    { status }
  )
}

/**
 * Build an error envelope.
 */
export function fail(
  message: string,
  opts: {
    status?: number
    errors?: ApiError[]
    data?: unknown
  } = {}
): NextResponse {
  const status = opts.status ?? 400
  return NextResponse.json<ApiEnvelope>(
    {
      success: false,
      message,
      data: opts.data ?? null,
      errors: opts.errors ?? [{ code: 'error', message }],
      timestamp: new Date().toISOString(),
      requestId: randomUUID(),
    },
    { status }
  )
}

/**
 * Common error helpers.
 */
export const apiError = {
  unauthorized: (msg = 'Authentication required') =>
    fail(msg, { status: 401, errors: [{ code: 'unauthorized', message: msg }] }),
  forbidden: (msg = 'You do not have permission to perform this action') =>
    fail(msg, { status: 403, errors: [{ code: 'forbidden', message: msg }] }),
  notFound: (msg = 'Resource not found') =>
    fail(msg, { status: 404, errors: [{ code: 'not_found', message: msg }] }),
  validation: (errors: ApiError[], msg = 'Validation failed') =>
    fail(msg, { status: 422, errors }),
  conflict: (msg = 'Resource already exists') =>
    fail(msg, { status: 409, errors: [{ code: 'conflict', message: msg }] }),
  rateLimited: (msg = 'Too many requests, please slow down') =>
    fail(msg, { status: 429, errors: [{ code: 'rate_limited', message: msg }] }),
  serverError: (msg = 'Internal server error') =>
    fail(msg, { status: 500, errors: [{ code: 'server_error', message: msg }] }),
  badRequest: (msg = 'Bad request') =>
    fail(msg, { status: 400, errors: [{ code: 'bad_request', message: msg }] }),
}
