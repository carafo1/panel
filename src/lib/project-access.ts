/**
 * Project access — who may do what to a project.
 *
 * A project is reachable by:
 *   - its owner (Project.userId): everything
 *   - platform admins (User.role admin / super_admin): everything, as before
 *   - members of the team the project is assigned to (Project.teamId), with
 *     the permissions of their TeamMember.role below
 *
 * Before this, every route checked `project.userId === me` on its own, so a
 * team gave its members nothing at all, although the UI said projects were
 * shared. Routes now ask one question — "may this user do X to this
 * project?" — and the answer comes from the table below.
 *
 * Permissions (each includes the ones above it):
 *
 *   view       see the project, status, deployments, build/container logs,
 *              stages, resources, monitors, analytics, pipeline runs
 *   deploy     deploy / redeploy, restart, stop, roll back, run pipelines
 *   configure  environment variables, files, cron jobs, redirects, IP
 *              blocking, SSL, domains, monitors, pipelines (edit)
 *   data       databases (studio, queries, import/export, phpMyAdmin /
 *              pgAdmin sign-in, credentials), backups (create, restore,
 *              download, delete), terminal, FTP accounts, mailboxes,
 *              site imports, malware scans
 *   owner      delete the project, move it in or out of a team, change its
 *              plan/billing-relevant settings — the project owner only
 *
 *   Team role  │ view deploy configure data owner
 *   ───────────┼────────────────────────────────────
 *   viewer     │  ✓
 *   developer  │  ✓     ✓       ✓
 *   admin      │  ✓     ✓       ✓       ✓
 *   owner*     │  ✓     ✓       ✓       ✓
 *   (* the TEAM's owner — not the project's; only the project owner has
 *      'owner' on a project)
 *
 * No access at all answers 404 (never reveal that a project exists); access
 * without the needed permission answers 403 with a plain explanation.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isAdmin } from '@/lib/security'

export type ProjectPermission = 'view' | 'deploy' | 'configure' | 'data' | 'owner'

/** How a user relates to a project. */
export type ProjectAccessRole =
  | 'owner' // Project.userId
  | 'platform_admin'
  | 'team_owner'
  | 'team_admin'
  | 'team_developer'
  | 'team_viewer'

const RANK: Record<ProjectPermission, number> = {
  view: 1,
  deploy: 2,
  configure: 3,
  data: 4,
  owner: 5,
}

/** Highest permission each relationship grants. */
const GRANTS: Record<ProjectAccessRole, number> = {
  owner: RANK.owner,
  platform_admin: RANK.owner,
  team_owner: RANK.data,
  team_admin: RANK.data,
  team_developer: RANK.configure,
  team_viewer: RANK.view,
}

/** Team member roles that can be assigned. */
export const TEAM_ROLES = ['admin', 'developer', 'viewer'] as const
export type TeamRole = (typeof TEAM_ROLES)[number] | 'owner'

export function can(role: ProjectAccessRole, permission: ProjectPermission): boolean {
  return GRANTS[role] >= RANK[permission]
}

function teamRoleToAccess(role: string): ProjectAccessRole {
  if (role === 'owner') return 'team_owner'
  if (role === 'admin') return 'team_admin'
  if (role === 'viewer') return 'team_viewer'
  return 'team_developer'
}

export interface ProjectAccess {
  projectId: string
  /** The project owner's id — use it for plan limits and billing, never the caller's. */
  ownerId: string
  role: ProjectAccessRole
  can: (permission: ProjectPermission) => boolean
}

/**
 * How `user` may access `projectId`, or null if not at all (or no project).
 */
export async function getProjectAccess(
  user: { userId: string; role?: string | null },
  projectId: string
): Promise<ProjectAccess | null> {
  if (!projectId) return null
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, teamId: true },
  })
  if (!project) return null

  let role: ProjectAccessRole | null = null
  if (project.userId === user.userId) role = 'owner'
  else if (isAdmin(user.role)) role = 'platform_admin'
  else if (project.teamId) {
    const member = await db.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId: user.userId } },
      select: { role: true },
    })
    if (member) role = teamRoleToAccess(member.role)
  }
  if (!role) return null

  const r = role
  return {
    projectId: project.id,
    ownerId: project.userId,
    role: r,
    can: (permission) => can(r, permission),
  }
}

const DENIED: Record<ProjectPermission, string> = {
  view: 'You do not have access to this project.',
  deploy: 'Your team role does not allow deploying or restarting this project. Ask a team admin.',
  configure: "Your team role does not allow changing this project's settings. Ask a team admin.",
  data: "Your team role does not allow access to this project's databases, backups, files on the server or terminal. Ask a team admin.",
  owner: 'Only the project owner can do this.',
}

/**
 * Route guard. Usage:
 *
 *   const access = await requireProjectAccess(decoded, projectId, 'configure')
 *   if (!access.ok) return access.response
 *   // access.ownerId → plan limits / billing; access.role → audit
 *
 * 404 when the user has no relationship to the project at all, 403 when they
 * do but their role is not enough.
 */
export async function requireProjectAccess(
  user: { userId: string; role?: string | null },
  projectId: string,
  permission: ProjectPermission
): Promise<({ ok: true } & ProjectAccess) | { ok: false; response: NextResponse }> {
  const access = await getProjectAccess(user, projectId)
  if (!access) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Project not found' }, { status: 404 }),
    }
  }
  if (!access.can(permission)) {
    return {
      ok: false,
      response: NextResponse.json({ error: DENIED[permission], requiredPermission: permission }, { status: 403 }),
    }
  }
  return { ok: true, ...access }
}

/**
 * Prisma `where` fragment for "projects this user can see" — their own plus
 * those of every team they belong to. Use it in list endpoints.
 */
export function accessibleProjectsWhere(userId: string) {
  return {
    OR: [
      { userId },
      { team: { members: { some: { userId } } } },
    ],
  }
}
