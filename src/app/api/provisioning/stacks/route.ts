/**
 * GET /api/provisioning/stacks
 * ===========================
 *
 * Public endpoint that lists the deployment stacks the orchestration engine
 * can provision. Used by the provisioning form UI to populate the stack
 * picker.
 *
 * Auth: none required (public, for the provisioning form).
 *
 * Response: { stacks: Array<{ id, name, description, icon }> }
 */
import { NextResponse } from 'next/server'
import { listStacks } from '@/lib/coolify'

export async function GET() {
  try {
    const stacks = listStacks()
    return NextResponse.json({ stacks })
  } catch (error) {
    console.error('[api/provisioning/stacks] error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
