---
Task ID: 18
Agent: Environment Variables Agent
Task: Build Environment Variables API endpoints + UI

Work Log:
- Read worklog.md and existing codebase (hosting-panel.tsx, auth.ts, auth-store.ts, API routes, Prisma schema)
- Created API endpoint `/api/hosting/[id]/env/route.ts` with GET (list env vars with masked values) and POST (create env var with key/value/encrypted) methods
- Created API endpoint `/api/hosting/[id]/env/[varId]/route.ts` with PATCH (update env var) and DELETE (delete env var) methods
- Both endpoints verify JWT auth via Authorization header, verify project ownership, and handle edge cases (duplicate keys, missing fields, not found)
- GET endpoint supports `?reveal=true` query param to return unmasked values
- Values are masked as "****last4" by default in GET responses
- Updated hosting-panel.tsx with complete Environment Variables UI section:
  - Added new icons: Eye, EyeOff, Key, Lock, Edit
  - Added EnvVar interface
  - Added env vars state management (list, loading, reveal toggle, dialog state, delete state)
  - Added fetchEnvVars callback with reveal toggle support
  - Added handleOpenEnvDialog, handleSaveEnvVar, handleDeleteEnvVar functions
  - Added Environment Variables card section between Settings and Danger Zone with:
    - Table showing key, masked/revealed value, encrypted/plain badge, edit/delete actions
    - Reveal/Hide toggle button
    - Add Variable button
    - Empty state with icon and CTA
    - Loading skeleton state
  - Added Environment Variable Dialog (create/edit mode) with key input, password value input, encrypted toggle
  - Added Env Var Delete Confirmation AlertDialog
- Lint passes cleanly, dev server running without errors

Stage Summary:
- 2 new API route files created: env/route.ts (GET+POST) and env/[varId]/route.ts (PATCH+DELETE)
- Hosting panel enhanced with full Environment Variables management UI
- Features: masked values, reveal toggle, encrypted badge, CRUD dialogs, confirmation dialogs
- Professional emerald accent theme consistent with existing patterns
