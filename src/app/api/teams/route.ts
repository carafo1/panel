import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
    }

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    // Find all teams where user is owner or member
    const ownedTeams = await db.team.findMany({
      where: { ownerId: decoded.userId },
      include: {
        members: true,
        projects: { select: { id: true } },
      },
    })

    const memberTeams = await db.team.findMany({
      where: {
        members: {
          some: { userId: decoded.userId },
        },
        ownerId: { not: decoded.userId },
      },
      include: {
        members: true,
        projects: { select: { id: true } },
      },
    })

    const allTeams = [...ownedTeams, ...memberTeams]

    // Determine the user's role in each team
    const teamsWithRole = allTeams.map((team) => {
      const membership = team.members.find((m) => m.userId === decoded.userId)
      return {
        id: team.id,
        name: team.name,
        slug: team.slug,
        memberCount: team.members.length,
        projectCount: team.projects.length,
        role: membership?.role || 'developer',
        createdAt: team.createdAt.toISOString(),
        updatedAt: team.updatedAt.toISOString(),
      }
    })

    // Deduplicate by id
    const seen = new Set<string>()
    const unique = teamsWithRole.filter((t) => {
      if (seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })

    return NextResponse.json({ teams: unique })
  } catch (error) {
    console.error('List teams error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
    }

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const body = await request.json()
    const { name } = body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Team name is required' }, { status: 400 })
    }

    let slug = slugify(name.trim())

    // Ensure unique slug
    const existing = await db.team.findUnique({ where: { slug } })
    if (existing) {
      slug = `${slug}-${Date.now().toString(36)}`
    }

    const team = await db.team.create({
      data: {
        name: name.trim(),
        slug,
        ownerId: decoded.userId,
        members: {
          create: {
            userId: decoded.userId,
            role: 'owner',
          },
        },
      },
      include: {
        members: true,
        projects: { select: { id: true } },
      },
    })

    return NextResponse.json({
      team: {
        id: team.id,
        name: team.name,
        slug: team.slug,
        memberCount: team.members.length,
        projectCount: team.projects.length,
        role: 'owner',
        createdAt: team.createdAt.toISOString(),
        updatedAt: team.updatedAt.toISOString(),
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Create team error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
