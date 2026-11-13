'use client'

import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '@/store/auth-store'
import { useAuthStore } from '@/store/auth-store'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Users,
  UserPlus,
  Shield,
  Crown,
  UserMinus,
  Trash2,
  Plus,
  ArrowLeft,
  MoreVertical,
  Loader2,
  X,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────

interface TeamListItem {
  id: string
  name: string
  slug: string
  memberCount: number
  projectCount: number
  role: string
  createdAt: string
  updatedAt: string
}

interface TeamMember {
  id: string
  userId: string
  role: string
  joinedAt: string
  user: {
    id: string
    name: string
    email: string
    avatar?: string | null
  }
}

interface TeamProject {
  id: string
  name: string
  slug: string
  status: string
  framework: string
  subdomain: string
  createdAt: string
}

interface TeamDetail {
  id: string
  name: string
  slug: string
  ownerId: string
  owner: { id: string; name: string; email: string }
  yourRole: string
  members: TeamMember[]
  projects: TeamProject[]
  createdAt: string
  updatedAt: string
}

// ── Role badge helper ────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  if (role === 'owner') {
    return <Badge className="bg-indigo-100 text-indigo-700 border-indigo-200 hover:bg-indigo-100"><Crown className="size-3 mr-1" />Owner</Badge>
  }
  if (role === 'admin') {
    return <Badge className="bg-amber-100 text-amber-700 border-amber-200 hover:bg-amber-100"><Shield className="size-3 mr-1" />Admin</Badge>
  }
  if (role === 'viewer') {
    return <Badge variant="outline">Viewer</Badge>
  }
  return <Badge variant="secondary">Developer</Badge>
}

/** What each team role may do on the team's projects (enforced server-side). */
const ROLE_HELP: Record<string, string> = {
  admin: 'Everything except deleting projects: deploy, settings, databases, backups, terminal, and managing members.',
  developer: 'Deploy, restart, and change settings, environment variables, files and cron. No databases, backups or terminal.',
  viewer: 'Read-only: status, deployments, logs and monitoring.',
}

function ProjectStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'running':
    case 'live':
      return <Badge className="bg-indigo-100 text-indigo-700 border-indigo-200">Live</Badge>
    case 'creating':
    case 'building':
    case 'deploying':
      return <Badge className="bg-amber-100 text-amber-700 border-amber-200">Building</Badge>
    case 'stopped':
      return <Badge variant="secondary">Stopped</Badge>
    case 'error':
    case 'failed':
      return <Badge variant="destructive">Failed</Badge>
    default:
      return <Badge variant="secondary">{status}</Badge>
  }
}

// ── Main Component ───────────────────────────────────────────────────────

export default function TeamsPanel() {
  const { user } = useAuthStore()
  const [teams, setTeams] = useState<TeamListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTeam, setSelectedTeam] = useState<TeamDetail | null>(null)
  const [teamLoading, setTeamLoading] = useState(false)

  // Dialogs
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [creating, setCreating] = useState(false)

  const [inviteDialogOpen, setInviteDialogOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('developer')

  // Sharing projects with the team
  const [myProjects, setMyProjects] = useState<Array<{ id: string; name: string; teamId: string | null }>>([])
  const [projectToAdd, setProjectToAdd] = useState('')
  const [sharing, setSharing] = useState(false)
  const [inviting, setInviting] = useState(false)

  const [deleteTeamDialogOpen, setDeleteTeamDialogOpen] = useState(false)
  const [removeMemberDialogOpen, setRemoveMemberDialogOpen] = useState(false)
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null)

  // Edit name
  const [editingName, setEditingName] = useState(false)
  const [editedName, setEditedName] = useState('')
  const [savingName, setSavingName] = useState(false)

  // ── Fetch teams ──────────────────────────────────────────────────────
  const fetchTeams = useCallback(async () => {
    try {
      const data = await apiFetch('/teams')
      setTeams(data.teams || [])
    } catch {
      toast.error('Failed to load teams')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTeams()
  }, [fetchTeams])

  // ── Fetch team detail ────────────────────────────────────────────────
  const fetchTeamDetail = useCallback(async (teamId: string) => {
    setTeamLoading(true)
    try {
      const data = await apiFetch(`/teams/${teamId}`)
      setSelectedTeam(data.team)
    } catch {
      toast.error('Failed to load team details')
    } finally {
      setTeamLoading(false)
    }
  }, [])

  // ── Create team ──────────────────────────────────────────────────────
  const handleCreateTeam = async () => {
    if (!newTeamName.trim()) return
    setCreating(true)
    try {
      const data = await apiFetch('/teams', {
        method: 'POST',
        body: JSON.stringify({ name: newTeamName.trim() }),
      })
      toast.success(`Team "${data.team.name}" created!`)
      setCreateDialogOpen(false)
      setNewTeamName('')
      fetchTeams()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create team')
    } finally {
      setCreating(false)
    }
  }

  // ── Update team name ─────────────────────────────────────────────────
  const handleUpdateName = async () => {
    if (!selectedTeam || !editedName.trim()) return
    setSavingName(true)
    try {
      await apiFetch(`/teams/${selectedTeam.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editedName.trim() }),
      })
      toast.success('Team name updated')
      setEditingName(false)
      fetchTeamDetail(selectedTeam.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update team')
    } finally {
      setSavingName(false)
    }
  }

  // ── Delete team ──────────────────────────────────────────────────────
  const handleDeleteTeam = async () => {
    if (!selectedTeam) return
    try {
      await apiFetch(`/teams/${selectedTeam.id}`, { method: 'DELETE' })
      toast.success('Team deleted')
      setSelectedTeam(null)
      setDeleteTeamDialogOpen(false)
      fetchTeams()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete team')
    }
  }

  // ── Invite member ────────────────────────────────────────────────────
  const handleInviteMember = async () => {
    if (!selectedTeam || !inviteEmail.trim()) return
    setInviting(true)
    try {
      await apiFetch(`/teams/${selectedTeam.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      })
      toast.success('Member invited!')
      setInviteDialogOpen(false)
      setInviteEmail('')
      setInviteRole('developer')
      fetchTeamDetail(selectedTeam.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to invite member')
    } finally {
      setInviting(false)
    }
  }

  // ── Change role ──────────────────────────────────────────────────────
  const handleChangeRole = async (memberId: string, newRole: string) => {
    if (!selectedTeam) return
    try {
      await apiFetch(`/teams/${selectedTeam.id}/members/${memberId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      })
      toast.success('Role updated')
      fetchTeamDetail(selectedTeam.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update role')
    }
  }

  // ── Remove member ────────────────────────────────────────────────────
  const handleRemoveMember = async () => {
    if (!selectedTeam || !removingMemberId) return
    try {
      await apiFetch(`/teams/${selectedTeam.id}/members/${removingMemberId}`, {
        method: 'DELETE',
      })
      toast.success('Member removed')
      setRemoveMemberDialogOpen(false)
      setRemovingMemberId(null)
      fetchTeamDetail(selectedTeam.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove member')
    }
  }

  // ── Share / unshare projects ─────────────────────────────────────────
  const loadMyProjects = useCallback(async () => {
    try {
      const data = await apiFetch<{ projects: Array<{ id: string; name: string; ownedByMe?: boolean; team?: { id: string } | null }> }>(
        '/hosting'
      )
      setMyProjects(
        data.projects
          .filter((p) => p.ownedByMe !== false)
          .map((p) => ({ id: p.id, name: p.name, teamId: p.team?.id ?? null }))
      )
    } catch {
      setMyProjects([])
    }
  }, [])

  useEffect(() => {
    if (selectedTeam) loadMyProjects()
  }, [selectedTeam, loadMyProjects])

  const handleShareProject = async () => {
    if (!selectedTeam || !projectToAdd) return
    setSharing(true)
    try {
      await apiFetch(`/teams/${selectedTeam.id}/projects`, {
        method: 'POST',
        body: JSON.stringify({ projectId: projectToAdd }),
      })
      toast.success('Project shared with the team')
      setProjectToAdd('')
      fetchTeamDetail(selectedTeam.id)
      loadMyProjects()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to share project')
    } finally {
      setSharing(false)
    }
  }

  const handleUnshareProject = async (projectId: string) => {
    if (!selectedTeam) return
    try {
      await apiFetch(`/teams/${selectedTeam.id}/projects?projectId=${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
      })
      toast.success('Project removed from the team')
      fetchTeamDetail(selectedTeam.id)
      loadMyProjects()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove project')
    }
  }

  // ── Leave team ───────────────────────────────────────────────────────
  const handleLeaveTeam = async () => {
    if (!selectedTeam || !user) return
    const myMembership = selectedTeam.members.find((m) => m.userId === user.id)
    if (!myMembership) return
    try {
      await apiFetch(`/teams/${selectedTeam.id}/members/${myMembership.id}`, {
        method: 'DELETE',
      })
      toast.success('You left the team')
      setSelectedTeam(null)
      fetchTeams()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to leave team')
    }
  }

  // ── Navigate to team detail ──────────────────────────────────────────
  const openTeamDetail = (teamId: string) => {
    fetchTeamDetail(teamId)
  }

  const backToList = () => {
    setSelectedTeam(null)
    fetchTeams()
  }

  // ── Loading state ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-8 w-32 bg-muted animate-pulse rounded" />
        <div className="grid gap-4 sm:grid-cols-2">
          {[1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-5 w-3/4 bg-muted rounded mb-3" />
                <div className="h-4 w-1/2 bg-muted rounded mb-2" />
                <div className="h-4 w-1/3 bg-muted rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  // ── Team Detail View ─────────────────────────────────────────────────
  if (selectedTeam) {
    const isOwner = selectedTeam.yourRole === 'owner'
    const isAdmin = selectedTeam.yourRole === 'admin'
    const canManage = isOwner || isAdmin

    if (teamLoading) {
      return (
        <div className="p-6 flex items-center justify-center min-h-[400px]">
          <Loader2 className="size-8 animate-spin text-indigo-500" />
        </div>
      )
    }

    return (
      <div className="p-6 space-y-6 max-w-5xl">
        {/* Back button */}
        <Button variant="ghost" size="sm" onClick={backToList} className="gap-2">
          <ArrowLeft className="size-4" />
          Back to Teams
        </Button>

        {/* Team Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            {editingName ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  className="text-xl font-bold w-64"
                  onKeyDown={(e) => e.key === 'Enter' && handleUpdateName()}
                />
                <Button size="sm" onClick={handleUpdateName} disabled={savingName}>
                  {savingName ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingName(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <h2 className="text-2xl font-bold">{selectedTeam.name}</h2>
                {canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditedName(selectedTeam.name)
                      setEditingName(true)
                    }}
                    className="text-muted-foreground"
                  >
                    Edit
                  </Button>
                )}
              </div>
            )}
            <p className="text-sm text-muted-foreground mt-1">
              {selectedTeam.slug} · {selectedTeam.members.length} member{selectedTeam.members.length !== 1 ? 's' : ''} · {selectedTeam.projects.length} project{selectedTeam.projects.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RoleBadge role={selectedTeam.yourRole} />
            {!isOwner && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1 text-red-600 hover:text-red-700">
                    <UserMinus className="size-4" />
                    Leave Team
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Leave Team</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to leave &quot;{selectedTeam.name}&quot;? You&apos;ll need to be re-invited to join again.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleLeaveTeam} className="bg-red-600 hover:bg-red-700">
                      Leave Team
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

        <Separator />

        {/* Members Section */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Users className="size-5" />
                  Members
                </CardTitle>
                <CardDescription>Manage team members and their roles</CardDescription>
              </div>
              {canManage && (
                <Button size="sm" onClick={() => setInviteDialogOpen(true)} className="gap-1">
                  <UserPlus className="size-4" />
                  Invite Member
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedTeam.members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="size-8">
                          <AvatarFallback className="bg-indigo-100 text-indigo-700 text-xs">
                            {member.user.name?.charAt(0).toUpperCase() || '?'}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{member.user.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{member.user.email}</TableCell>
                    <TableCell><RoleBadge role={member.role} /></TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(member.joinedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* Change Role — owner only */}
                        {isOwner && member.role !== 'owner' && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="gap-1">
                                <Shield className="size-3.5" />
                                Role
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => handleChangeRole(member.id, 'admin')}
                                disabled={member.role === 'admin'}
                              >
                                <Shield className="size-3.5 mr-2" /> Admin
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleChangeRole(member.id, 'developer')}
                                disabled={member.role === 'developer'}
                              >
                                <Users className="size-3.5 mr-2" /> Developer
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleChangeRole(member.id, 'viewer')}
                                disabled={member.role === 'viewer'}
                              >
                                <Users className="size-3.5 mr-2" /> Viewer (read-only)
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}

                        {/* Remove member */}
                        {member.role !== 'owner' && canManage && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1 text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => {
                              setRemovingMemberId(member.id)
                              setRemoveMemberDialogOpen(true)
                            }}
                          >
                            <UserMinus className="size-3.5" />
                            Remove
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Projects Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="size-5" />
              Team Projects
            </CardTitle>
            <CardDescription>
              Projects shared with this team. Members get access according to their role; billing and deletion stay with each project's owner.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {canManage && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1 grid gap-1.5">
                  <Label htmlFor="share-project">Share one of your projects</Label>
                  <Select value={projectToAdd} onValueChange={setProjectToAdd}>
                    <SelectTrigger id="share-project">
                      <SelectValue placeholder={myProjects.some((p) => p.teamId !== selectedTeam.id) ? 'Choose a project' : 'No projects left to share'} />
                    </SelectTrigger>
                    <SelectContent>
                      {myProjects
                        .filter((p) => p.teamId !== selectedTeam.id)
                        .map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}{p.teamId ? ' (moves from its current team)' : ''}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={handleShareProject} disabled={!projectToAdd || sharing} className="gap-1.5">
                  <Plus className="size-4" />
                  {sharing ? 'Sharing…' : 'Share project'}
                </Button>
              </div>
            )}
            {selectedTeam.projects.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Shield className="size-10 mx-auto mb-3 opacity-30" />
                <p>No projects yet</p>
                <p className="text-sm">
                  {canManage
                    ? 'Share one of your projects above to give the team access.'
                    : 'A team owner or admin can share projects with this team.'}
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {selectedTeam.projects.map((project) => (
                  <div
                    key={project.id}
                    className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                  >
                    <div>
                      <div className="font-medium">{project.name}</div>
                      <div className="text-sm text-muted-foreground">{project.subdomain}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <ProjectStatusBadge status={project.status} />
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => handleUnshareProject(project.id)}
                          aria-label={`Stop sharing ${project.name} with this team`}
                        >
                          <X className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Danger Zone — Owner only */}
        {isOwner && (
          <>
            <Separator />
            <Card className="border-red-200">
              <CardHeader>
                <CardTitle className="text-red-600 flex items-center gap-2">
                  <Trash2 className="size-5" />
                  Danger Zone
                </CardTitle>
                <CardDescription>Irreversible actions for this team</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Delete this team</p>
                    <p className="text-sm text-muted-foreground">
                      This will permanently delete the team and remove all members. This action cannot be undone.
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setDeleteTeamDialogOpen(true)}
                    className="gap-1"
                  >
                    <Trash2 className="size-4" />
                    Delete Team
                  </Button>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {/* ── Invite Member Dialog ──────────────────────────────────────── */}
        <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite Member</DialogTitle>
              <DialogDescription>
                Invite a user to join &quot;{selectedTeam.name}&quot; by their email address
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="invite-email">Email Address</Label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="user@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="invite-role">Role</Label>
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger id="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="developer">Developer</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="viewer">Viewer (read-only)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1.5">{ROLE_HELP[inviteRole]}</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInviteDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleInviteMember} disabled={inviting || !inviteEmail.trim()}>
                {inviting ? <Loader2 className="size-4 animate-spin mr-2" /> : <UserPlus className="size-4 mr-2" />}
                Invite
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Remove Member Confirmation ────────────────────────────────── */}
        <AlertDialog open={removeMemberDialogOpen} onOpenChange={setRemoveMemberDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove Member</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to remove this member from the team? They will need to be re-invited to join again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setRemovingMemberId(null)}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleRemoveMember} className="bg-red-600 hover:bg-red-700">
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* ── Delete Team Confirmation ──────────────────────────────────── */}
        <AlertDialog open={deleteTeamDialogOpen} onOpenChange={setDeleteTeamDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Team</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete &quot;{selectedTeam.name}&quot;? This action is permanent and cannot be undone.
                All members will be removed and team projects will be unlinked.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDeleteTeam} className="bg-red-600 hover:bg-red-700">
                Delete Team
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }

  // ── Team List View ───────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-lg bg-indigo-100 flex items-center justify-center">
            <Users className="size-5 text-indigo-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold">Teams</h2>
            <p className="text-sm text-muted-foreground">Collaborate with your team members</p>
          </div>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} className="gap-1">
          <Plus className="size-4" />
          Create Team
        </Button>
      </div>

      {/* Team list or empty state */}
      {teams.length === 0 ? (
        <Card>
          <CardContent className="py-16 flex flex-col items-center text-center">
            <div className="size-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <Users className="size-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No teams yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md">
              Create a team to collaborate with others on projects. Invite members, assign roles, and manage projects together.
            </p>
            <Button onClick={() => setCreateDialogOpen(true)} className="gap-1">
              <Plus className="size-4" />
              Create your first team
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {teams.map((team) => (
            <Card
              key={team.id}
              className="hover:border-indigo-300 transition-colors cursor-pointer group"
              onClick={() => openTeamDetail(team.id)}
            >
              <CardContent className="p-6">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-semibold text-lg group-hover:text-indigo-600 transition-colors">
                      {team.name}
                    </h3>
                    <p className="text-sm text-muted-foreground">{team.slug}</p>
                  </div>
                  <RoleBadge role={team.role} />
                </div>
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Users className="size-3.5" />
                    {team.memberCount} member{team.memberCount !== 1 ? 's' : ''}
                  </span>
                  <span className="flex items-center gap-1">
                    <Shield className="size-3.5" />
                    {team.projectCount} project{team.projectCount !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="mt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1 group-hover:bg-indigo-50 group-hover:border-indigo-300 group-hover:text-indigo-700 transition-colors"
                  >
                    Manage
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Create Team Dialog ──────────────────────────────────────────── */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Team</DialogTitle>
            <DialogDescription>
              Give your team a name to get started. You can invite members after creation.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="team-name">Team Name</Label>
            <Input
              id="team-name"
              placeholder="e.g. Engineering Team"
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateTeam()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateTeam} disabled={creating || !newTeamName.trim()}>
              {creating ? <Loader2 className="size-4 animate-spin mr-2" /> : <Plus className="size-4 mr-2" />}
              Create Team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
