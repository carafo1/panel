import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  getPaymentMethod,
  togglePaymentMethod,
  updatePaymentMethodConfig,
} from '@/lib/payment-methods'

/**
 * Authorisation helper: super admin only (with permissive `admin` fallback
 * during the role-transition window).
 */
function requireSuperAdmin(request: Request): {
  decoded: { userId: string; email: string; role: string }
} | null {
  const authHeader = request.headers.get('Authorization')
  const token = extractTokenFromHeader(authHeader)
  if (!token) return null
  const decoded = verifyToken(token)
  if (!decoded) return null
  if (decoded.role !== 'super_admin' && decoded.role !== 'admin') return null
  return { decoded }
}

interface RouteContext {
  params: Promise<{ method: string }>
}

/**
 * GET /api/admin/payment-methods/[method]
 *
 * Return a single payment method's full settings (including config).
 * Super admin only.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = requireSuperAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Super admin access required' },
        { status: 403 }
      )
    }

    const { method } = await context.params
    if (!method) {
      return NextResponse.json(
        { error: 'Method parameter is required' },
        { status: 400 }
      )
    }

    const methodRow = await getPaymentMethod(method)
    if (!methodRow) {
      return NextResponse.json(
        { error: `Payment method "${method}" not found` },
        { status: 404 }
      )
    }

    return NextResponse.json({ method: methodRow })
  } catch (error) {
    console.error('Get payment method error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/admin/payment-methods/[method]
 *
 * Update one payment method. Body (any subset is allowed):
 *   {
 *     active?: boolean,
 *     config?: any,
 *     displayName?: string,
 *     icon?: string,
 *     sortOrder?: number
 *   }
 *
 * Super admin only.
 */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const auth = requireSuperAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Super admin access required' },
        { status: 403 }
      )
    }

    const { method: methodParam } = await context.params
    if (!methodParam) {
      return NextResponse.json(
        { error: 'Method parameter is required' },
        { status: 400 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const { active, config, displayName, icon, sortOrder } = body as {
      active?: boolean
      config?: any
      displayName?: string
      icon?: string
      sortOrder?: number
    }

    // Ensure the method exists (seeds defaults if not).
    const existing = await getPaymentMethod(methodParam)
    if (!existing) {
      return NextResponse.json(
        { error: `Payment method "${methodParam}" not found` },
        { status: 404 }
      )
    }

    // Toggle active first if requested
    if (typeof active === 'boolean') {
      const toggleResult = await togglePaymentMethod(methodParam, active)
      if (!toggleResult.success) {
        return NextResponse.json(
          { error: `Failed to update payment method "${methodParam}"` },
          { status: 500 }
        )
      }
    }

    // Update config / display name / icon / sort order if requested
    if (
      config !== undefined ||
      displayName !== undefined ||
      icon !== undefined ||
      sortOrder !== undefined
    ) {
      const configResult = await updatePaymentMethodConfig(
        methodParam,
        config ?? null,
        {
          displayName,
          icon,
          sortOrder,
        }
      )
      if (!configResult.success) {
        return NextResponse.json(
          { error: `Failed to update config for "${methodParam}"` },
          { status: 500 }
        )
      }
    }

    await logAudit({
      userId: auth.decoded.userId,
      action: 'admin.payment_method.update',
      resource: 'payment_method',
      resourceId: methodParam,
      req: request,
      metadata: {
        method: methodParam,
        active,
        updatedConfig: config !== undefined,
        updatedDisplayName: displayName !== undefined,
        updatedIcon: icon !== undefined,
        updatedSortOrder: sortOrder !== undefined,
      },
    })

    const refreshed = await getPaymentMethod(methodParam)
    return NextResponse.json({
      success: true,
      method: refreshed,
    })
  } catch (error) {
    console.error('Update payment method error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
