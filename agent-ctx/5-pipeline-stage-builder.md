# Task 5: Visual Drag-and-Drop Stage Builder for Pipelines Panel

## Summary
Enhanced the pipelines panel at `/home/z/my-project/src/components/pipelines/pipelines-panel.tsx` with a comprehensive visual drag-and-drop stage builder, pipeline run visualization, and detail view enhancements.

## Changes Made

### 1. Visual Stage Builder with dnd-kit
- Replaced the simple `VisualStageEditor` with a full `@dnd-kit/core` + `@dnd-kit/sortable` powered drag-and-drop stage editor
- **SortableStageCard** component: Uses `useSortable` hook for drag-and-drop reordering with visual feedback (opacity change during drag, grip handle)
- **DragOverlay**: Shows a floating card preview while dragging
- **StagePickerDialog**: Visual grid picker with 7 predefined stage types (Build 🏗️, Test 🧪, Deploy 🚀, Package 📦, Lint 🔍, Notify 📧, Custom ⚙️) - each with emoji, icon, default command, and color coding
- **StageConfigDialog**: Full configuration dialog for each stage with fields for: name, type, command, working directory, timeout, continue-on-error toggle, and environment variables (KEY=value format)
- Arrow connectors (`→`) between stage cards using `ArrowRight` from lucide-react

### 2. Pipeline Run Visualization
- **HorizontalRunProgress**: Horizontal stage-by-stage progress bar with:
  - Color-coded status: gray=pending, blue/sky=running, green=success, red=failed, yellow=skipped
  - Animated spinner (`Loader2` with `animate-spin`) for running stages
  - Click-to-select stage interaction for viewing logs
  - Glowing ring effect on running stages
  - Status-colored connector arrows between stages
- **RunTimeline**: Enhanced vertical timeline with:
  - Expandable/collapsible log output per stage
  - Status-colored timeline lines (green for success, red for failed)
  - Status icons and badges per stage
  - Duration display
- Selected stage detail card showing focused log output

### 3. Pipeline Detail View Enhancement
- Added **Tabs** component with three tabs:
  - **Visual Tab**: Shows `PipelineFlowchart` (horizontal flowchart with Start/End nodes and connected stage cards) + Recent Runs with mini progress bars
  - **Editor Tab**: Full visual stage editor with drag-and-drop
  - **Runs Tab**: Classic run history list
- **PipelineFlowchart**: Read-only horizontal flowchart with:
  - Start node (green circle with Play icon)
  - Stage cards with type-specific colors and icons
  - End node (gray circle with CheckCircle2 icon)
  - Connector arrows between nodes
- **Trigger Configuration Sidebar Card**: Shows branch, events, status, and stage count
- Run history items now include mini colored progress bars showing stage statuses with tooltips

### 4. Expanded Type System
- Updated `PipelineStage` interface with new fields: `id`, `command`, `workingDir`, `env`, `timeout`, `continueOnError`
- Added stage types: `package`, `lint`, `notify` (in addition to existing `build`, `test`, `deploy`, `custom`)
- `STAGE_TYPES` constant defining all 7 stage types with emojis, icons, default commands, and color schemes
- `migrateStages()` function for backward compatibility with old stage format (config.command → command)
- `generateStageId()` for unique stage identifiers
- `createDefaultStage()` factory function

### 5. Other Enhancements
- Stage cards show configuration pills (timeout, continue-on-error, env vars count, working directory)
- Drag handle with `GripVertical` icon
- Tooltips on stage card action buttons
- `RotateCcw` icon for Re-run button
- Mini progress bars in pipeline list items showing stage flow with colored badges
- Responsive layout with grid system for pipeline info + trigger config sidebar

## Technical Details
- All dnd-kit imports from `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`
- Used `horizontalListSortingStrategy` for horizontal drag-and-drop
- `arrayMove` for reordering on drag end
- CSS.Transform.toString for smooth drag animations
- No lint errors, no build errors
- Existing CRUD, run triggering, and listing functionality preserved
