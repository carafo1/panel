import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { seedDatabase } from '@/lib/seed'

export async function GET() {
  try {
    let plans = await db.plan.findMany({
      orderBy: { priority: 'asc' },
    })

    // If no plans exist, seed the database
    if (plans.length === 0) {
      await seedDatabase()
      plans = await db.plan.findMany({
        orderBy: { priority: 'asc' },
      })
    }

    return NextResponse.json({ plans })
  } catch (error) {
    console.error('Get plans error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
