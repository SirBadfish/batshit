import type { IconRef } from '$lib/icons/iconTypes'
import {
  buildDefaultProject,
  normalizeDefaultProjectPath
} from '$lib/projects/defaultProject'

// Projects store using Svelte 5 runes
export interface Project {
  id: string
  user_id: string
  name: string
  root_path: string
  rules_json?: any
  max_depth?: number
  custom_exclusions?: string[]
  icon_ref?: IconRef | null
  /** BL-2373: true only on the Default Project built from the Default Project Path (never stored). */
  is_default_project?: boolean
  created_at: string
  updated_at: string
}

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  mtime?: string
  children?: FileTreeNode[]
  isExpanded?: boolean
  /** True once this directory's children were fetched (lazy loading cache marker). */
  childrenLoaded?: boolean
  /** True while this directory's children are being fetched. */
  childrenLoading?: boolean
  /** User-safe load failure for this directory; null/undefined when healthy. */
  childrenError?: string | null
}

export interface FlatFileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  mtime?: string
  extension?: string
}

export type MentionIndexStatus = 'idle' | 'loading' | 'ready' | 'error'

let projects = $state<Project[]>([])
let currentProjectId = $state<string | null>(null)
// BL-2373: the saved Default Project Path, the one source of the Default Project. Null until a
// successful preferences read (or when the path is blank).
let defaultProjectPath = $state<string | null>(null)
let defaultProjectCache: { path: string | null; project: Project | null } = { path: null, project: null }
// Counts every write of the path, so a read that started before a newer write can tell it is old.
let defaultProjectPathRevision = 0
let fileTree = $state<FileTreeNode[]>([])
let flatFileList = $state<FlatFileEntry[]>([])
let activeFilePath = $state<string | null>(null)
let loading = $state(false)
let loadingStatus = $state<string>('')
let error = $state<string | null>(null)
let loadedProjectIds = $state<Set<string>>(new Set())
let fileTreeLoadedAt = $state<number | null>(null)
let fileTreeStale = $state(false)
let mentionIndexStatus = $state<MentionIndexStatus>('idle')
let mentionIndexError = $state<string | null>(null)
let mentionIndexTruncated = $state(false)

/** The saved project records only (what `/api/projects` returns). */
export function getProjects() {
  return projects
}

export function getDefaultProjectPath() {
  return defaultProjectPath
}

/**
 * Read the saved Default Project Path and install it, unless the path was written while the read
 * was on its way (a save in Settings is newer than the read that started before it). Answers
 * whether the read was installed; a failed read throws and changes nothing.
 */
export async function loadDefaultProjectPath(
  read: () => Promise<{ default_workspace_path?: string | null } | null>
): Promise<boolean> {
  const revision = defaultProjectPathRevision
  const preferences = await read()
  if (defaultProjectPathRevision !== revision) return false
  setDefaultProjectPath(preferences?.default_workspace_path ?? null)
  return true
}

/** Takes the saved Default Project Path as read or saved; a blank or relative value means none. */
export function setDefaultProjectPath(path: string | null | undefined) {
  keepingTreeWithItsFolder(() => {
    defaultProjectPathRevision += 1
    defaultProjectPath = normalizeDefaultProjectPath(path)
  })
}

/**
 * BL-2373 / BL-2391: a project keeps its id when its folder changes (the Default Project when the
 * Default Project Path changes, a saved project when its Root Path is edited, saved, or a list
 * read brings the new root). The shown tree and @ mention index of the old folder are cleared
 * here, whichever writer changed it, as if the project had been switched; chat already sends
 * the new root, and an open sidebar loads the new folder (`ProjectsSidebar`).
 */
function keepingTreeWithItsFolder(write: () => void) {
  const shownId = currentProjectId
  const previousRoot = getCurrentProject()?.root_path ?? null
  write()
  const nextRoot = getCurrentProject()?.root_path ?? null
  if (shownId && shownId === currentProjectId && previousRoot && nextRoot && previousRoot !== nextRoot) {
    clearFileTreeState()
    loadedProjectIds.delete(shownId)
  }
}

/** BL-2373: the Default Project for the saved Default Project Path, or null when it is blank. */
export function getDefaultProject(): Project | null {
  const path = defaultProjectPath
  if (defaultProjectCache.path !== path) {
    defaultProjectCache = { path, project: buildDefaultProject(path) }
  }
  return defaultProjectCache.project
}

/** What the Projects sidebar offers: the Default Project first, then the saved projects. */
export function getSelectableProjects(): Project[] {
  const defaultProject = getDefaultProject()
  return defaultProject ? [defaultProject, ...projects] : projects
}

export function getCurrentProject() {
  return getSelectableProjects().find(p => p.id === currentProjectId) || null
}

export function getCurrentProjectId() {
  return currentProjectId
}

export function getFileTree() {
  return fileTree
}

export function getFlatFileList() {
  return flatFileList
}

export function getActiveFilePath() {
  return activeFilePath
}

export function isLoading() {
  return loading
}

export function getLoadingStatus() {
  return loadingStatus
}

export function getError() {
  return error
}

export function getFileTreeLoadedAt() {
  return fileTreeLoadedAt
}

export function isFileTreeStale() {
  return fileTreeStale
}

export function getMentionIndexStatus() {
  return mentionIndexStatus
}

export function getMentionIndexError() {
  return mentionIndexError
}

export function isMentionIndexTruncated() {
  return mentionIndexTruncated
}

/**
 * Install a project list: it replaces the store's copies, whatever their stamps. A backup restore
 * rewrites records without a newer `updated_at`, and a server clock can step back, so an older
 * stamp is no proof that the store's copy is newer. A list the server read before a save landed
 * is corrected where it is read (`ProjectService.loadProjects`, `applySavedAnswersSince`).
 */
export function setProjects(newProjects: Project[]) {
  keepingTreeWithItsFolder(() => {
    projects = newProjects
  })
}

export function addProject(project: Project) {
  projects = [...projects, project]
}

export function updateProject(id: string, updates: Partial<Project>) {
  keepingTreeWithItsFolder(() => {
    projects = projects.map(p =>
      p.id === id ? { ...p, ...updates } : p
    )
  })
}

export function deleteProject(id: string) {
  projects = projects.filter(p => p.id !== id)
  // BL-2373: never fall onto another saved project; the agent's selection rule picks again.
  if (currentProjectId === id) {
    setCurrentProject(null)
  }
  if (loadedProjectIds.has(id)) {
    loadedProjectIds.delete(id)
  }
}

export function setCurrentProject(id: string | null) {
  const previousProjectId = currentProjectId
  currentProjectId = id

  // Only clear file tree if switching to a different project
  if (id !== previousProjectId) {
    clearFileTreeState()
  }
}

function clearFileTreeState() {
  fileTree = []
  flatFileList = []
  activeFilePath = null
  error = null
  fileTreeLoadedAt = null
  fileTreeStale = false
  mentionIndexStatus = 'idle'
  mentionIndexError = null
  mentionIndexTruncated = false
}

/**
 * Replace the tree with freshly loaded root-level nodes (lazy loading entry point).
 * Directory children stay unloaded until expanded.
 */
export function setFileTreeRoot(rootNodes: FileTreeNode[]) {
  fileTree = rootNodes
  fileTreeLoadedAt = Date.now()
  fileTreeStale = false
  // Mark current project as loaded
  if (currentProjectId) {
    loadedProjectIds.add(currentProjectId)
  }
}

export function hasProjectBeenLoaded(projectId: string): boolean {
  return loadedProjectIds.has(projectId)
}

export function markFileTreeStale() {
  fileTreeStale = true
}

export function clearFileTreeStale() {
  fileTreeStale = false
}

export function setActiveFile(path: string | null) {
  activeFilePath = path
}

/**
 * Immutably update the node at `path`. Traversal is pruned to the branch that
 * contains the path. Returns true when the node was found and updated.
 */
function updateTreeNode(
  path: string,
  updater: (node: FileTreeNode) => FileTreeNode
): boolean {
  let found = false

  function walk(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.map(node => {
      if (node.path === path) {
        found = true
        return updater(node)
      }
      if (
        node.type === 'directory' &&
        node.children &&
        path.startsWith(`${node.path}/`)
      ) {
        return { ...node, children: walk(node.children) }
      }
      return node
    })
  }

  const next = walk(fileTree)
  if (found) {
    fileTree = next
  }
  return found
}

/** Find a node by project-relative path in the loaded tree (null when not loaded). */
export function findTreeNode(path: string): FileTreeNode | null {
  function walk(nodes: FileTreeNode[]): FileTreeNode | null {
    for (const node of nodes) {
      if (node.path === path) return node
      if (
        node.type === 'directory' &&
        node.children &&
        path.startsWith(`${node.path}/`)
      ) {
        return walk(node.children)
      }
    }
    return null
  }
  return walk(fileTree)
}

export function setDirectoryExpanded(path: string, expanded: boolean) {
  updateTreeNode(path, node =>
    node.type === 'directory' ? { ...node, isExpanded: expanded } : node
  )
}

/** Mark a directory as fetching children. Expands it so the loading state is visible in place. */
export function setDirectoryLoading(path: string, isLoadingChildren: boolean) {
  updateTreeNode(path, node =>
    node.type === 'directory'
      ? {
          ...node,
          childrenLoading: isLoadingChildren,
          ...(isLoadingChildren ? { isExpanded: true, childrenError: null } : {})
        }
      : node
  )
}

/** Cache fetched children for a directory and expand it. */
export function setDirectoryChildren(path: string, children: FileTreeNode[]) {
  updateTreeNode(path, node =>
    node.type === 'directory'
      ? {
          ...node,
          children,
          childrenLoaded: true,
          childrenLoading: false,
          childrenError: null,
          isExpanded: true
        }
      : node
  )
}

/** Record a user-safe load failure for a directory. Keeps it expanded so the error shows in place. */
export function setDirectoryError(path: string, message: string) {
  updateTreeNode(path, node =>
    node.type === 'directory'
      ? {
          ...node,
          childrenLoading: false,
          childrenError: message,
          isExpanded: true
        }
      : node
  )
}

/** Project-relative paths of every currently expanded directory (used to restore expansion after refresh). */
export function getExpandedDirectoryPaths(): string[] {
  const paths: string[] = []

  function walk(nodes: FileTreeNode[]) {
    for (const node of nodes) {
      if (node.type === 'directory' && node.isExpanded) {
        paths.push(node.path)
      }
      if (node.type === 'directory' && node.children) {
        walk(node.children)
      }
    }
  }

  walk(fileTree)
  return paths
}

/** Mark the mention index as hydrating. Existing entries stay usable while the new walk runs. */
export function setMentionIndexLoading() {
  mentionIndexStatus = 'loading'
  mentionIndexError = null
}

/** Hydrate the @ mention index from the background full walk. */
export function setMentionIndex(flatList: FlatFileEntry[], truncated = false) {
  flatFileList = flatList
  mentionIndexStatus = 'ready'
  mentionIndexError = null
  mentionIndexTruncated = truncated
}

/**
 * Record a mention-index hydration failure. Previously indexed entries are kept
 * so autocomplete degrades to whatever was indexed instead of going empty.
 */
export function setMentionIndexError(message: string) {
  mentionIndexStatus = 'error'
  mentionIndexError = message
}

export function setLoading(isLoading: boolean) {
  loading = isLoading
  if (!isLoading) {
    loadingStatus = ''
  }
}

export function setLoadingStatus(status: string) {
  loadingStatus = status
}

export function setError(errorMsg: string | null) {
  error = errorMsg
}
