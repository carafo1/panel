import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  getAllPaymentMethods,
  togglePaymentMethod,
  updatePaymentMethodConfig,
} from '@/lib/payment-methods'

/**
 * Authorisation helper: super admin only (with a permissive fallback to
 * `admin` during the role-transition window).
 *
 * Returns a NextResponse on failure, or null when the caller is allowed.
 */
function requireSuperAdmin(request: Request): {
  decoded: { userId: string; email: string; role: string }
} | null {
  const authHeader = request.headers.get('Authorization')
  const token = extractTokenFromHeader(authHeader)
  if (!token) return null
  const decoded = verifyToken(token)
  if (!decoded) return null
  // Allow `super_admin` always; allow `admin` during the transition.
  if (decoded.role !== 'super_admin' && decoded.role !== 'admin') return null
  return { decoded }
}

/**
 * GET /api/admin/payment-methods
 *
 * Returns ALL payment methods (active + inactive) so the super admin
 * can manage them. Super admin only.
 */
export async function GET(request: Request) {
  try {
    const auth = requireSuperAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Super admin access required' },
        { status: 403 }
      )
    }

    const methods = await getAllPaymentMethods()

    return NextResponse.json({
      methods: methods.map((m) => ({
        method: m.method,
        displayName: m.displayName,
        active: m.active,
        icon: m.icon,
        sortOrder: m.sortOrder,
        config: m.config,
      })),
    })
  } catch (error) {
    console.error('Get all payment methods error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/admin/payment-methods
 *
 * Update one payment method. Body shape:
 *   {
 *     method: string,        // required - "stripe" | "waafi" | "manual"
 *     active?: boolean,      // toggle active/inactive
 *     config?: any,          // update JSON config
 *     displayName?: string,  // update display name
 *     icon?: string,         // update icon
 *     sortOrder?: number     // update sort order
 *   }
 *
 * Super admin only.
 */
export async function PATCH(request: Request) {
  try {
    const auth = requireSuperAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Super admin access required' },
        { status: 403 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const {
      method,
      active,
      config,
      displayName,
      icon,
      sortOrder,
    } = body as {
      method?: string
      active?: boolean
      config?: any
      displayName?: string
      icon?: string
      sortOrder?: number
    }

    if (!method || typeof method !== 'string') {
      return NextResponse.json(
        { error: 'method is required' },
        { status: 400 }
      )
    }

    // Toggle active first if requested
    if (typeof active === 'boolean') {
      const toggleResult = await togglePaymentMethod(method, active)
      if (!toggleResult.success) {
        return NextResponse.json(
          { error: `Failed to update payment method "${method}"` },
          { status: 500 }
        )
      }
    }

    // Update config / display name / icon / sort order if requested.
    // We always send config through updatePaymentMethodConfig so the
    // JSON-stringification is centralised.
    if (
      config !== undefined ||
      displayName !== undefined ||
      icon !== undefined ||
      sortOrder !== undefined
    ) {
      const configResult = await updatePaymentMethodConfig(
        method,
        config ?? null,
        {
          displayName,
          icon,
          sortOrder,
        }
      )
      if (!configResult.success) {
        return NextResponse.json(
          { error: `Failed to update config for "${method}"` },
          { status: 500 }
        )
      }
    }

    // Audit log
    await logAudit({
      userId: auth.decoded.userId,
      action: 'admin.payment_method.update',
      resource: 'payment_method',
      resourceId: method,
      req: request,
      metadata: {
        method,
        active,
        updatedConfig: config !== undefined,
        updatedDisplayName: displayName !== undefined,
        updatedIcon: icon !== undefined,
        updatedSortOrder: sortOrder !== undefined,
      },
    })

    return NextResponse.json({
      success: true,
      method,
      active: typeof active === 'boolean' ? active : undefined,
    })
  } catch (error) {
    console.error('Update payment method error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
