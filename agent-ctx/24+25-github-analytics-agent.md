# Task 24+25: GitHub + Analytics Agent

## Work Completed

### GitHub Integration (Task 24)

**API Endpoints Created:**
1. `POST /api/github/connect/route.ts` - Simulated GitHub OAuth flow
   - Accepts `{ projectId, repoUrl, branch? }`
   - Parses repo URL to extract username and repoFullName
   - Creates GithubIntegration record with simulated tokens
   - Returns integration record

2. `POST /api/github/disconnect/route.ts` - Disconnect GitHub
   - Accepts `{ projectId }`
   - Deletes GithubIntegration record for the project
   - Returns success

3. `GET /api/github/[id]/repos/route.ts` - Simulated repositories
   - Returns 9 fake repos with names, stars, language, updated dates

4. `GET /api/github/[id]/commits/route.ts` - Simulated commit history
   - Returns 15 fake commits with messages, authors, dates, SHAs

**Hosting Panel Updates:**
- Added GitHub Integration section between Environment Variables and Danger Zone
- Not connected: "Connect GitHub" button → dialog with repo URL, branch, auto-deploy toggle
- Connected: repo info with GitHub icon, branch badge, auto-deploy status
- Commit History dialog with author avatar, message, relative time, SHA short
- Trigger Redeploy button
- Disconnect button with AlertDialog confirmation
- Updated `/api/hosting/[id]/route.ts` to include githubIntegration relation

### Analytics Dashboard (Task 25)

**API Endpoints Created:**
1. `GET /api/analytics/[projectId]/route.ts` - Analytics summary
   - Accepts `?period=24h|7d|30d`
   - Returns: totalRequests, avgResponseTime, errorRate, bandwidth, uniqueVisitors, requestsByDay, topPaths, responseTimeByDay, geoDistribution
   - Computes from real AnalyticsEvent records when available (>10 events)
   - Falls back to realistic simulated data

2. `POST /api/analytics/[projectId]/events/route.ts` - Ingest events
   - Accepts single or array of events
   - Creates AnalyticsEvent records

**Analytics Panel Component:**
- Header with project selector, period toggle (24h/7d/30d), live indicator
- 4 stat cards: Total Requests, Avg Response Time, Error Rate, Unique Visitors
- Requests Over Time: div-based bar chart with emerald/red bars
- Response Time: SVG line chart with avg (green) and P95 (amber) lines
- Top Paths: horizontal bar chart with emerald gradient
- Geographic Distribution: country flag + name + count + progress bar
- Bandwidth card with refresh button
- All custom charts, NO external chart libraries
- Responsive layout

**Dashboard Wiring:**
- Added 'analytics' to DashboardTab type
- Added Analytics nav item with BarChart3 icon
- Added AnalyticsPanel case to renderPanel()
- Imported AnalyticsPanel component

## Files Modified
- `/src/app/api/github/connect/route.ts` (new)
- `/src/app/api/github/disconnect/route.ts` (new)
- `/src/app/api/github/[id]/repos/route.ts` (new)
- `/src/app/api/github/[id]/commits/route.ts` (new)
- `/src/app/api/analytics/[projectId]/route.ts` (new)
- `/src/app/api/analytics/[projectId]/events/route.ts` (new)
- `/src/app/api/hosting/[id]/route.ts` (updated - githubIntegration include)
- `/src/components/hosting/hosting-panel.tsx` (updated - GitHub Integration section)
- `/src/components/analytics/analytics-panel.tsx` (new)
- `/src/store/app-store.ts` (updated - analytics tab type)
- `/src/app/page.tsx` (updated - Analytics nav item + panel rendering)
