'use client'

/**
 * Website import — routed into the single "New website" flow.
 *
 * Without a project this opens the flow on "Move my existing website here".
 * With `projectId` it imports into that existing website (backup → confirm),
 * using POST /api/hosting/[id]/migrate. Progress, retry and rollback are in
 * ./new-website/import-progress.tsx.
 */

import NewWebsiteWizard from './new-website/new-website-wizard'
import type { MigrationView } from './migration-progress'

export interface ImportWizardProps {
  open: boolean
  onClose: () => void
  /** Called when an import finishes so the caller can refresh its list. */
  onCompleted?: () => void
  /** Import into an existing website instead of creating one. */
  projectId?: string
  projectName?: string
  /** Kept for compatibility: the flow itself offers a fresh install now. */
  onChooseFreshInstall?: () => void
  /** Called as soon as a new website was created for the import. */
  onCreated?: (project: { id: string; name: string }) => void
}

export default function ImportWizard({
  open,
  onClose,
  onCompleted,
  projectId,
  projectName,
  onCreated,
}: ImportWizardProps) {
  return (
    <NewWebsiteWizard
      open={open}
      onClose={onClose}
      initialGoal="move"
      target={projectId ? { projectId, projectName: projectName ?? 'this website' } : undefined}
      onCreated={onCreated}
      onImportFinished={(m: MigrationView) => {
        if (m.status === 'completed' || m.status === 'failed' || m.status === 'rolled_back') onCompleted?.()
      }}
    />
  )
}
