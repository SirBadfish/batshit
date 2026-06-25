import type { ChatFolderRow, ChatSessionRow } from '$lib/types/database'

export type DeleteFolderResult = {
  success: boolean
  error?: string
  moved_to?: string
  deleted_sessions?: number
}

export type MoveSessionsResult = {
  success: boolean
  movedCount?: number
}

interface FoldersState {
  folders: ChatFolderRow[]
  loading: boolean
  error: string | null
}

// Create the reactive state using Svelte 5 runes
let state = $state<FoldersState>({
  folders: [],
  loading: false,
  error: null
})

function parseTimestampMs(value?: string | null) {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

function getFolderActivityMs(folder: ChatFolderRow, sessions: ChatSessionRow[] = []) {
  let activityMs = Math.max(
    parseTimestampMs(folder.last_used_at),
    parseTimestampMs(folder.created_at)
  )

  for (const session of sessions) {
    if (session.archived || session.folder_id !== folder.id) continue
    activityMs = Math.max(
      activityMs,
      parseTimestampMs(session.last_modified_at),
      parseTimestampMs(session.created_at)
    )
  }

  return activityMs
}

export function sortFoldersForDisplay(
  folders: ChatFolderRow[],
  sessions: ChatSessionRow[] = []
) {
  return [...folders].sort((a, b) => {
    if (a.is_default !== b.is_default) {
      return a.is_default ? -1 : 1
    }

    const activityDelta = getFolderActivityMs(b, sessions) - getFolderActivityMs(a, sessions)
    if (activityDelta !== 0) return activityDelta

    const createdDelta = parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at)
    if (createdDelta !== 0) return createdDelta

    const sortDelta = a.sort_order - b.sort_order
    if (sortDelta !== 0) return sortDelta

    return a.name.localeCompare(b.name)
  })
}

// Computed values using $derived
let foldersSorted = $derived(sortFoldersForDisplay(state.folders))

let defaultFolder = $derived(
  state.folders.find(f => f.is_default) || null
)

// Helper to compute session counts for folders
function computeFolderCounts(folders: ChatFolderRow[], sessions: ChatSessionRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  
  for (const folder of folders) {
    const count = sessions.filter(s => s.folder_id === folder.id && !s.archived).length
    counts.set(folder.id, count)
  }
  
  return counts
}

// Folder operations
async function loadFolders() {
  state.loading = true
  state.error = null
  
  try {
    const response = await fetch('/api/folders')
    if (!response.ok) {
      throw new Error(`Failed to load folders: ${response.statusText}`)
    }
    
    const folders = await response.json()
    state.folders = folders
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Failed to load folders'
    console.error('Error loading folders:', error)
  } finally {
    state.loading = false
  }
}

async function createFolder(name: string, sortOrder?: number): Promise<ChatFolderRow | null> {
  try {
    const resolvedSortOrder =
      typeof sortOrder === 'number'
        ? sortOrder
        : Math.max(...state.folders.map((folder) => folder.sort_order), -1) + 1
    const response = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, sort_order: resolvedSortOrder })
    })
    
    if (!response.ok) {
      throw new Error(`Failed to create folder: ${response.statusText}`)
    }
    
    const newFolder = await response.json()
    
    // Optimistically add to local state
    state.folders = [...state.folders, newFolder]
    
    return newFolder
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Failed to create folder'
    console.error('Error creating folder:', error)
    return null
  }
}

async function renameFolder(folderId: string, newName: string): Promise<boolean> {
  return updateFolder(folderId, { name: newName })
}

async function updateFolder(
  folderId: string, 
  updates: Partial<Pick<ChatFolderRow, 'name' | 'sort_order' | 'is_expanded'>>
): Promise<boolean> {
  try {
    // Optimistic update
    const folderIndex = state.folders.findIndex(f => f.id === folderId)
    if (folderIndex !== -1) {
      const updatedFolder = { ...state.folders[folderIndex], ...updates }
      state.folders[folderIndex] = updatedFolder
    }
    
    const response = await fetch(`/api/folders/${folderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })
    
    if (!response.ok) {
      // Revert optimistic update on failure
      await loadFolders()
      throw new Error(`Failed to update folder: ${response.statusText}`)
    }
    
    return true
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Failed to update folder'
    console.error('Error updating folder:', error)
    return false
  }
}

async function deleteFolder(
  folderId: string,
  options: { deleteSessions?: boolean } = {}
): Promise<DeleteFolderResult> {
  try {
    const folder = state.folders.find(f => f.id === folderId)
    if (folder?.is_default) {
      state.error = 'Cannot delete the default folder'
      return { success: false, error: state.error }
    }
    
    const params = options.deleteSessions ? '?deleteSessions=true' : ''
    const response = await fetch(`/api/folders/${folderId}${params}`, {
      method: 'DELETE'
    })
    
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null)
      throw new Error(errorPayload?.error || `Failed to delete folder: ${response.statusText}`)
    }

    const result = await response.json() as DeleteFolderResult
    
    // Remove from local state
    state.folders = state.folders.filter(f => f.id !== folderId)
    
    return { ...result, success: true }
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Failed to delete folder'
    console.error('Error deleting folder:', error)
    return { success: false, error: state.error }
  }
}

async function moveSessionsToFolder(
  targetFolderId: string, 
  sessionIds: string[]
): Promise<MoveSessionsResult> {
  try {
    const response = await fetch(`/api/folders/${targetFolderId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds })
    })
    
    if (!response.ok) {
      throw new Error(`Failed to move sessions: ${response.statusText}`)
    }

    const result = await response.json()
    
    return { success: true, movedCount: result.moved_count }
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Failed to move sessions'
    console.error('Error moving sessions:', error)
    return { success: false }
  }
}

// Toggle folder expanded state
function toggleFolderExpanded(folderId: string) {
  const folder = state.folders.find(f => f.id === folderId)
  if (folder) {
    updateFolder(folderId, { is_expanded: !folder.is_expanded })
  }
}

// Set a folder as the default
async function setDefaultFolder(folderId: string): Promise<boolean> {
  const previousFolders = state.folders
  // Update local state immediately for instant UI feedback
  state.folders = state.folders.map(f => ({
    ...f,
    is_default: f.id === folderId
  }))

  try {
    const response = await fetch(`/api/folders/${folderId}/set-default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null)
      throw new Error(errorPayload?.error || `Failed to set default folder: ${response.statusText}`)
    }

    await loadFolders()
    return true
  } catch (error) {
    state.folders = previousFolders
    state.error = error instanceof Error ? error.message : 'Failed to set default folder'
    console.error('Error setting default folder:', error)
    return false
  }
}

function validateFolderName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, error: 'Folder name cannot be empty' }
  }

  if (name.length > 50) {
    return { valid: false, error: 'Folder name must be 50 characters or less' }
  }

  const invalidChars = /[<>:"/\\|?*]/
  if (invalidChars.test(name)) {
    return { valid: false, error: 'Folder name contains invalid characters' }
  }

  return { valid: true }
}

// Export the store interface
export const foldersStore = {
  // State
  get folders() { return state.folders },
  get loading() { return state.loading },
  get error() { return state.error },
  
  // Computed
  get foldersSorted() { return foldersSorted },
  get defaultFolder() { return defaultFolder },
  sortFoldersForDisplay,
  
  // Methods
  loadFolders,
  createFolder,
  renameFolder,
  updateFolder,
  deleteFolder,
  moveSessionsToFolder,
  toggleFolderExpanded,
  setDefaultFolder,
  validateFolderName,
  computeFolderCounts
}
