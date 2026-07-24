/**
 * Database Studio route — /db-studio/<projectId>/<dbId>
 * Full-height workspace. Auth + ownership are enforced by the API the client
 * component calls (it sends the tenant's bearer token). This route will also be
 * linked from the hosting project's Databases tab.
 */
import { DatabaseStudio } from '@/components/db-studio/database-studio'

export default async function DbStudioPage({
  params,
}: {
  params: Promise<{ projectId: string; dbId: string }>
}) {
  const { projectId, dbId } = await params
  return (
    <div className="h-[100dvh] overflow-hidden bg-background">
      <DatabaseStudio projectId={projectId} dbId={dbId} />
    </div>
  )
}
