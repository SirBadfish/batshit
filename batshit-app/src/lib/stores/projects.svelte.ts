import type { IconRef } from '$lib/icons/iconTypes'

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

export function getProjects() {
  return projects
}

export function getCurrentProject() {
  return projects.find(p => p.id === currentProjectId) || null
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

export function setProjects(newProjects: Project[]) {
  projects = newProjects
}

export function addProject(project: Project) {
  projects = [...projects, project]
}

export function updateProject(id: string, updates: Partial<Project>) {
  projects = projects.map(p =>
    p.id === id ? { ...p, ...updates } : p
  )
}

export function deleteProject(id: string) {
  projects = projects.filter(p => p.id !== id)
  if (currentProjectId === id) {
    currentProjectId = projects[0]?.id || null
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
