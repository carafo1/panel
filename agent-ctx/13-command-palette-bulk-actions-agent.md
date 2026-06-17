# Task ID: 13 — Command Palette + Bulk Actions Agent

## Summary
Implemented Cmd+K command palette and bulk actions & search across the DeployHub dashboard.

## Files Created
- `src/components/command-palette.tsx` — cmdk-based palette with Navigation/Actions/Quick Links groups, theme toggle, sign-out, and create-project event dispatch.
- `src/app/api/hosting/bulk/route.ts` — POST endpoint for deploy/stop/restart/delete on multiple projects (auth + ownership verified, per-project result reporting, audit logged).

## Files Modified
- `src/app/page.tsx` — integrated `<CommandPalette />` inside `Dashboard` (auth-only), added "Search or jump to…" button (with ⌘K hint) in top bar.
- `src/app/api/hosting/route.ts` — added `?search=&status=&framework=&sort=` query params; backwards compatible.
- `src/components/hosting/hosting-panel.tsx` — added debounced search (300ms), status/framework/sort dropdowns, multi-select with shift+range, sticky bulk-action toolbar (Deploy/Stop/Restart/Delete/Clear), bulk-delete confirmation AlertDialog. Listens for `deployhub:command:create-project` event from the command palette.
- `src/components/deployments/deployments-panel.tsx` — added debounced search by project/branch/commit/subdomain; existing status tabs now show counts that respect the active search.

## Event Bus
Custom window events for cross-panel coordination:
- `deployhub:open-command-palette` — any component can open the palette.
- `deployhub:command:create-project` — palette tells HostingPanel to open the create dialog (with a small delay to allow tab switch first).

## Notes for Next Agents
- The hosting API now expects query params; if you call `/api/hosting` without them, it behaves exactly like before.
- The bulk delete endpoint hard-deletes projects (cascade removes deployments, env vars, etc.). The single-project DELETE route (`/api/hosting/[id]`) still soft-stops (sets status to `stopped`) — that behavior was intentionally left unchanged to avoid breaking existing UI.
- The bulk toolbar's "Stop All" only operates on `running` projects; non-running projects return an error in the per-project results array.
