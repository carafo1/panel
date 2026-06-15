# Task 2-b: CI/CD Pipeline API Routes

## Work Summary

Created 4 API route files for the CI/CD Pipeline system, following existing project patterns.

### Files Created

1. **`/src/app/api/pipelines/route.ts`** — GET (list user's pipelines) and POST (create pipeline)
   - GET: Lists all pipelines for authenticated user, includes project info and last run info
   - POST: Creates pipeline with name, projectId, description, stages, triggerBranch, triggerEvents
   - Validates stages as JSON array, default stages provided if none specified
   - Validates triggerEvents, defaults to `["push"]`
   - Verifies project ownership before creation

2. **`/src/app/api/pipelines/[id]/route.ts`** — GET, PATCH, DELETE
   - GET: Returns pipeline detail with project info and last 10 runs
   - PATCH: Updates pipeline fields (name, description, stages, status, triggerBranch, triggerEvents)
   - DELETE: Deletes pipeline (cascade deletes runs via Prisma schema)
   - Validates status transitions (draft, active, paused)

3. **`/src/app/api/pipelines/[id]/runs/route.ts`** — GET (list runs) and POST (trigger run)
   - GET: Lists all runs for a pipeline, ordered by startedAt desc
   - POST: Triggers a simulated pipeline run
     - Creates PipelineRun with immediately completed status
     - Simulates success/failure (70% success rate overall)
     - Generates realistic stage results with status, duration, and output messages
     - Updates pipeline's lastRunAt and lastRunStatus
     - Only allows runs on active pipelines

4. **`/src/app/api/pipelines/[id]/runs/[runId]/route.ts`** — GET (single run detail)
   - Returns run with parsed stageResults array for easy frontend consumption
   - Includes pipeline summary info

### Patterns Used
- Auth: `verifyToken` + `extractTokenFromHeader` pattern
- Dynamic routes: `params: Promise<{ id: string }>` with `const { id } = await params`
- Proper error responses with status codes (401, 400, 404, 500)
- Consistent ISO date formatting via `.toISOString()`
- JSON string storage for stages/triggerEvents (SQLite compatible)

### Lint
- All pipeline API files pass ESLint cleanly (pre-existing page.tsx error is unrelated)
