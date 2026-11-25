'use client'

/**
 * Create Website Wizard — now the "New website" flow.
 *
 * Creating a site and importing one used to be two separate wizards with two
 * entry points. Both are the same guided flow now
 * (./new-website/new-website-wizard.tsx), which starts by asking the goal:
 * a new WordPress site, moving an existing site, uploading a site, or
 * deploying code. This default export keeps the old props so existing
 * callers (and the command palette's "create project") keep working.
 */

import NewWebsiteWizard, { type Goal } from './new-website/new-website-wizard'

interface CreateWebsiteWizardProps {
  open: boolean
  onClose: () => void
  onCreated: (project: { id: string; name: string }) => void
  /** Open a created website (its management page). */
  onOpenProject?: (projectId: string) => void
  /** Skip the goal question, e.g. "move" for an Import button. */
  initialGoal?: Goal
}

export default function CreateWebsiteWizard({
  open,
  onClose,
  onCreated,
  onOpenProject,
  initialGoal,
}: CreateWebsiteWizardProps) {
  return (
    <NewWebsiteWizard
      open={open}
      onClose={onClose}
      initialGoal={initialGoal}
      onCreated={onCreated}
      onOpenProject={onOpenProject}
    />
  )
}
