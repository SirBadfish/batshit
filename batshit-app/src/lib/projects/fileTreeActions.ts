import { toast } from 'svelte-sonner'

import { FILE_TREE_MAX_ENTRIES, FileTreeService } from '$lib/services/fileTree'
import * as projectStore from '$lib/stores/projects.svelte'
import type { Project } from '$lib/stores/projects.svelte'

/**
 * Shared orchestration for the lazy Projects file tree.
 *
 * - `loadProjectTree` fetches only the project root's first level, then kicks
 *   off the background @ mention index walk (non-blocking).
 * - `expandDirectory` fetches one directory's children on demand and caches
 *   them in the store; collapsing keeps the cache.
 * - `refreshProjectTree` reloads the root and re-fetches previously expanded
 *   directories so refresh does not collapse the user's view.
 *
 * Errors are classified `FileTreeError`s from `FileTreeService` with user-safe
 * messages. Tree failures surface in the sidebar + toast; mention-index
 * failures are logged and surfaced subtly (sidebar footer + autocomplete
 * notice) so they never block tree interactivity.
 */

// Guards against stale async results applying after a newer load started.
let treeLoadSeq = 0
let mentionIndexSeq = 0

// Directories with an in-flight children fetch (project-relative paths).
const expandInFlight = new Set<string>()

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function truncationWarning(totalBeforeTruncation?: number): string {
  const total = totalBeforeTruncation?.toLocaleString() ?? 'many'
  return `Large folder: showing the first ${FILE_TREE_MAX_ENTRIES.toLocaleString()} of ${total} entries. Add folder exclusions in project settings to narrow the scan.`
}

/**
 * Load the project root's first level and start the background mention-index
 * walk. The tree is interactive as soon as the root level lands.
 */
export async function loadProjectTree(
  project: Project,
  options: { notify?: boolean } = {}
): Promise<void> {
  await loadRootLevel(project, options)
}

/**
 * Refresh the tree in place: reload the root level, then re-fetch the
 * directories that were expanded before the refresh. Also re-runs the
 * background mention-index walk.
 */
export async function refreshProjectTree(
  project: Project,
  options: { notify?: boolean } = {}
): Promise<void> {
  const expandedPaths = projectStore.getExpandedDirectoryPaths()
  const rootLoaded = await loadRootLevel(project, options)
  if (!rootLoaded) return

  // Re-expand top-down so parent nodes exist before their children are fetched.
  const sortedPaths = [...expandedPaths].sort(
    (a, b) => a.split('/').length - b.split('/').length
  )
  for (const path of sortedPaths) {
    if (projectStore.getCurrentProjectId() !== project.id) return
    if (!projectStore.findTreeNode(path)) continue // directory no longer exists
    await expandDirectory(path)
  }
}

/** Returns true when the root level was applied to the store. */
async function loadRootLevel(
  project: Project,
  options: { notify?: boolean } = {}
): Promise<boolean> {
  const notify = options.notify ?? false
  const seq = ++treeLoadSeq

  projectStore.setLoading(true)
  projectStore.setError(null)
  projectStore.setLoadingStatus('Loading project files...')

  try {
    const result = await FileTreeService.loadDirectoryChildren(
      project.root_path,
      '',
      project.custom_exclusions || []
    )
    if (seq !== treeLoadSeq || projectStore.getCurrentProjectId() !== project.id) {
      return false
    }

    projectStore.setFileTreeRoot(result.children)
    if (result.truncated) {
      toast.warning(truncationWarning(result.totalBeforeTruncation))
    }
    if (notify) {
      toast.success(`Loaded ${project.name} file tree`)
    }

    // Background @ mention index hydration — intentionally not awaited so the
    // tree stays interactive while the full walk runs.
    void hydrateMentionIndex(project)
    return true
  } catch (error) {
    if (seq !== treeLoadSeq || projectStore.getCurrentProjectId() !== project.id) {
      return false
    }
    console.error('Error loading file tree:', error)
    // FileTreeService throws classified errors with user-safe messages
    const message = errorMessage(error, 'Failed to load file tree')
    projectStore.setError(message)
    toast.error(message)
    return false
  } finally {
    if (seq === treeLoadSeq) {
      projectStore.setLoading(false)
    }
  }
}

/**
 * Expand a directory. Uses the cached children when this directory was already
 * loaded; otherwise fetches exactly one level for it. Failures surface as a
 * per-directory error state in the tree — never a silent empty folder.
 */
export async function expandDirectory(path: string): Promise<void> {
  const project = projectStore.getCurrentProject()
  if (!project) return

  const node = projectStore.findTreeNode(path)
  if (!node || node.type !== 'directory') return

  if (node.childrenLoaded) {
    projectStore.setDirectoryExpanded(path, true)
    return
  }

  const inFlightKey = `${project.id}:${path}`
  if (expandInFlight.has(inFlightKey)) return
  expandInFlight.add(inFlightKey)
  projectStore.setDirectoryLoading(path, true)

  try {
    const result = await FileTreeService.loadDirectoryChildren(
      project.root_path,
      path,
      project.custom_exclusions || []
    )
    if (projectStore.getCurrentProjectId() !== project.id) return

    projectStore.setDirectoryChildren(path, result.children)
    if (result.truncated) {
      toast.warning(truncationWarning(result.totalBeforeTruncation))
    }
  } catch (error) {
    if (projectStore.getCurrentProjectId() !== project.id) return
    console.error(`[fileTreeActions] Failed to load folder "${path}":`, error)
    // FileTreeService throws classified errors with user-safe messages
    projectStore.setDirectoryError(path, errorMessage(error, 'Failed to load folder'))
  } finally {
    expandInFlight.delete(inFlightKey)
  }
}

/**
 * Hydrate the @ mention index with the existing full recursive lite walk
 * (45s timeout). Runs in the background; failure or truncation degrades
 * autocomplete to whatever is indexed and is logged + surfaced subtly.
 */
export async function hydrateMentionIndex(project: Project): Promise<void> {
  const seq = ++mentionIndexSeq
  projectStore.setMentionIndexLoading()

  try {
    const result = await FileTreeService.loadFileTree(
      project.root_path,
      project.max_depth || 10,
      project.custom_exclusions || []
    )
    if (seq !== mentionIndexSeq || projectStore.getCurrentProjectId() !== project.id) {
      return
    }

    projectStore.setMentionIndex(result.flat, result.truncated)
    if (result.truncated) {
      console.warn(
        `[fileTreeActions] @ mention index truncated at ${FILE_TREE_MAX_ENTRIES.toLocaleString()} of ${result.totalBeforeTruncation?.toLocaleString() ?? 'unknown'} entries for project "${project.name}". Add folder exclusions in project settings to narrow the scan.`
      )
    }
  } catch (error) {
    if (seq !== mentionIndexSeq || projectStore.getCurrentProjectId() !== project.id) {
      return
    }
    console.error('[fileTreeActions] @ mention index hydration failed:', error)
    projectStore.setMentionIndexError(
      errorMessage(error, 'Failed to index project files for @ mentions')
    )
  }
}
