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

/**
 * Whether a load started for `project` may still change the shown tree: the same project id AND
 * the same root folder. BL-2373: the Default Project keeps its id when the Default Project Path
 * changes (and a saved project keeps its id when its Root Path is edited), so an answer for the
 * old folder that lands after the change must be dropped, never shown as the new folder's files.
 */
function isStillShown(project: Project): boolean {
  const current = projectStore.getCurrentProject()
  return current?.id === project.id && current.root_path === project.root_path
}

/**
 * BL-2373 review A4: the Default Project is built from a free-text setting and is shown for every
 * agent on Default, so its background @ mention walk never starts by itself over a filesystem
 * root, a disk, a system folder or a home folder. Its top level still lists, and folders still
 * open on expand. Saved projects keep their walk: the user created each one for its folder.
 *
 * The path is resolved first (`.`, `..`, repeated and trailing slashes) and matched without
 * case (macOS volumes are case-insensitive by default). The macOS data volume
 * (`/System/Volumes/Data`) shows the same tree as `/`, so it is read as `/`. Broad means: `/`;
 * `/Users`, `/home`, `/Volumes`, `/media`, `/mnt`, `/private` and one name under each (a home
 * folder, a mounted disk such as WSL's `/mnt/c`, `/private/tmp`); and `/root`, `/var/root`. Never
 * a folder inside them, such as `/Users/tester/project`.
 */
export const BROAD_DEFAULT_PROJECT_INDEX_NOTE =
  'Not indexed for @ mentions: the Default Project is a whole disk or home folder. Set its Root Path to a folder inside it to use @ mentions.'

const BROAD_TOP_FOLDERS = new Set(['users', 'home', 'volumes', 'media', 'mnt', 'private'])

function resolvedPathParts(rootPath: string): string[] {
  const parts: string[] = []
  for (const part of rootPath.trim().replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part.toLowerCase())
  }
  return parts
}

export function isBroadFolder(rootPath: string): boolean {
  let parts = resolvedPathParts(rootPath)
  if (parts[0] === 'system' && parts[1] === 'volumes' && parts[2] === 'data') parts = parts.slice(3)
  if (parts.length === 0) return true
  const joined = parts.join('/')
  if (joined === 'root' || joined === 'var/root' || joined === 'private/var/root') return true
  return parts.length <= 2 && BROAD_TOP_FOLDERS.has(parts[0])
}

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
    if (!isStillShown(project)) return
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
    if (seq !== treeLoadSeq || !isStillShown(project)) {
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
    // tree stays interactive while the full walk runs. Never by itself for a Default Project
    // whose folder is a whole disk or a home folder (`isBroadFolder`).
    if (project.is_default_project && isBroadFolder(project.root_path)) {
      projectStore.setMentionIndexError(BROAD_DEFAULT_PROJECT_INDEX_NOTE)
    } else {
      void hydrateMentionIndex(project)
    }
    return true
  } catch (error) {
    if (seq !== treeLoadSeq || !isStillShown(project)) {
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
    if (!isStillShown(project)) return

    projectStore.setDirectoryChildren(path, result.children)
    if (result.truncated) {
      toast.warning(truncationWarning(result.totalBeforeTruncation))
    }
  } catch (error) {
    if (!isStillShown(project)) return
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
    if (seq !== mentionIndexSeq || !isStillShown(project)) {
      return
    }

    projectStore.setMentionIndex(result.flat, result.truncated)
    if (result.truncated) {
      console.warn(
        `[fileTreeActions] @ mention index truncated at ${FILE_TREE_MAX_ENTRIES.toLocaleString()} of ${result.totalBeforeTruncation?.toLocaleString() ?? 'unknown'} entries for project "${project.name}". Add folder exclusions in project settings to narrow the scan.`
      )
    }
  } catch (error) {
    if (seq !== mentionIndexSeq || !isStillShown(project)) {
      return
    }
    console.error('[fileTreeActions] @ mention index hydration failed:', error)
    projectStore.setMentionIndexError(
      errorMessage(error, 'Failed to index project files for @ mentions')
    )
  }
}
