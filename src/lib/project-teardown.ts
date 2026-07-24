import { db } from '@/lib/db'
import { removeProjectContainer, dropProjectDatabase, deleteBackup } from '@/lib/vps'

/**
 * Permanently delete a project: tear down its VPS footprint, then remove the
 * Project row along with every child row that does not cascade.
 *
 * This lives in one place because the single-project DELETE and the bulk
 * delete action both need it and had drifted apart — the single-project route
 * only ever marked the row 'stopped' (so the site stayed in the customer's
 * hosting list after they confirmed a permanent delete), and the bulk route
 * dropped the row without ever tearing down the container (leaving orphans
 * holding their host ports).
 *
 * Teardown is best-effort and never aborts the delete: the customer asked for
 * the project to be gone, so the row always goes. Anything that could not be
 * cleaned up on the server is returned in `warnings` for the caller to surface
 * rather than being swallowed.
 *
 * This performs NO authorization check — it deletes whatever id it is handed.
 * Callers must confirm the project belongs to the requesting user first.
 */
export async function purgeProject(projectId: string): Promise<{ warnings: string[] }> {
  const warnings: string[] = []

  const note = (context: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[purgeProject] ${context} failed for ${projectId}:`, message)
    warnings.push(`${context} failed: ${message}`)
  }

  // ── 1. Tear down the real VPS deployment ──────────────────────────────
  // removeProjectContainer() gracefully handles demo mode (no sshHost),
  // missing containers, and un-deployed projects. It removes the Caddy proxy
  // entry, runs `docker compose down -v --rmi local` on the VPS, deletes
  // /opt/deployhub/projects/<slug>, and clears the row's container fields.
  try {
    const result = await removeProjectContainer(projectId)
    if (!result.ok) warnings.push(result.message)
  } catch (err) {
    note('Container teardown', err)
  }

  // ── 2. Drop provisioned databases and stored backups ──────────────────
  // Both helpers need the Project row to still exist, so they must run before
  // step 3. Each is isolated: one database that refuses to drop must not
  // strand the remaining databases, the backups, or the delete itself.
  try {
    const databases = await db.websiteDatabase.findMany({
      where: { projectId },
      select: { id: true, name: true },
    })
    for (const d of databases) {
      try {
        const result = await dropProjectDatabase(projectId, d.id)
        if (!result.ok) warnings.push(`Database ${d.name}: ${result.message}`)
      } catch (err) {
        note(`Dropping database ${d.name}`, err)
      }
    }
  } catch (err) {
    note('Database cleanup', err)
  }

  try {
    const backups = await db.websiteBackup.findMany({
      where: { projectId },
      select: { id: true, filename: true },
    })
    for (const b of backups) {
      try {
        const result = await deleteBackup(projectId, b.id)
        if (!result.ok) warnings.push(`Backup ${b.filename}: ${result.message}`)
      } catch (err) {
        note(`Deleting backup ${b.filename}`, err)
      }
    }
  } catch (err) {
    note('Backup cleanup', err)
  }

  // ── 3. Remove the Project row and its children ────────────────────────
  // Twelve relations declare onDelete: Cascade and clean themselves up (env
  // vars, analytics events, pipelines, uptime monitors, cron jobs, FTP
  // accounts, redirects, IP blocks, site migrations, and the website
  // databases/backups/domains). Of the rest — verified against the live
  // SQLite schema, not just schema.prisma:
  //
  //   Deployment        ON DELETE RESTRICT → MUST be deleted first, or
  //                     project.delete() raises a foreign-key violation.
  //                     This is the only relation that can block the delete.
  //   AutomationLog     ON DELETE SET NULL → deleted, not orphaned.
  //   GithubIntegration ON DELETE SET NULL → deleted; an orphan would sit
  //                     there holding a live OAuth access token.
  //   Webhook           ON DELETE SET NULL → deleted; an orphan would keep
  //                     its secret and its delivery rows (which do cascade).
  //   Domain            ON DELETE SET NULL → detached, which is what we
  //                     want: a customer can own a domain independently of
  //                     the site it points at. Done explicitly anyway so the
  //                     intent survives a future change to the relation.
  //
  // Deployment history is NOT preserved. Nothing can read it once the project
  // is gone (every deployment route scopes by project), and the AuditLog entry
  // the caller writes — which has no FK to Project — is the durable record.
  //
  // Wrapped in a transaction so a failure part-way cannot strip a project's
  // deployments and then leave the project itself standing.
  await db.$transaction([
    db.deployment.deleteMany({ where: { projectId } }),
    db.automationLog.deleteMany({ where: { projectId } }),
    db.githubIntegration.deleteMany({ where: { projectId } }),
    db.webhook.deleteMany({ where: { projectId } }),
    db.domain.updateMany({ where: { projectId }, data: { projectId: null } }),
    db.project.delete({ where: { id: projectId } }),
  ])

  return { warnings }
}
