import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import {
  SessionDeleteRefusedError,
  deleteSessionStoppingItsTurn
} from '$lib/server/services/sessionDeleteTurnStop'
import type { ChatFolderRow } from '$lib/types/database'
import { FOLDER_CHANGED_CODE } from '$lib/server/services/folderChatsForDelete'

// PUT /api/folders/{id} - Update folder (rename, reorder, expand/collapse)
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.session?.user_id || locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const folderId = params.id
  
  try {
    // Get update data
    const updates = await request.json()
    
    // Update folder
    const updatedFolder = await redis.updateFolder(userId, folderId, updates)
    
    if (!updatedFolder) {
      return json({ error: 'Folder not found' }, { status: 404 })
    }
    
    return json(updatedFolder)
  } catch (error) {
    console.error('Error updating folder:', error)
    return json({ error: 'Failed to update folder' }, { status: 500 })
  }
}

/**
 * BL-388: Delete Folder + Sessions stopped partway (a chat's delete refused or failed) or found a
 * chat that arrived meanwhile. The chats before stay deleted and the folder stays; the answer
 * says how far it got and why, in words the page shows as they are.
 */
function folderDeleteStoppedAnswer(result: {
  code?: string
  deleted_sessions?: number
  total_sessions?: number
  stopped_at?: { name: string; locked: boolean }
  cause?: unknown
}) {
  const deleted = result.deleted_sessions ?? 0
  const total = result.total_sessions ?? deleted
  const done =
    deleted === 0 ? 'No chat was deleted.' : `Deleted ${deleted} of ${total} chat${total === 1 ? '' : 's'}.`
  const counts = { deleted_sessions: deleted, total_sessions: total }
  if (result.code === 'folder_not_empty') {
    return json(
      { error: `${done} A new chat arrived in the folder, so the folder remains.`, code: result.code, ...counts },
      { status: 409 }
    )
  }
  const name = `"${result.stopped_at?.name ?? 'a chat'}"`
  const cause = result.cause
  if (cause instanceof SessionDeleteRefusedError) {
    const why =
      cause.code === 'session_turn_still_stopping' ? 'is still stopping' : 'is already being deleted'
    return json(
      { error: `${done} ${name} ${why}, so it and the folder remain. Try again.`, code: cause.code, ...counts },
      { status: 409 }
    )
  }
  if (result.stopped_at?.locked) {
    return json(
      { error: `${done} ${name} was locked, so it and the folder remain.`, code: 'session_locked', ...counts },
      { status: 409 }
    )
  }
  console.error('Error deleting a chat of a folder:', cause)
  return json(
    { error: `${done} ${name} could not be deleted, so it and the folder remain. Try again.`, code: result.code, ...counts },
    { status: 500 }
  )
}

// DELETE /api/folders/{id} - Delete folder.
// Default behavior moves chats to the default folder. Add ?deleteSessions=true
// to permanently delete the folder's sessions instead.
export const DELETE: RequestHandler = async ({ params, locals, url, request }) => {
  const userId = locals.session?.user_id || locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const folderId = params.id
  
  try {
    // Check if folder exists and is not default
    const folder = await redis.getFolder(userId, folderId)
    
    if (!folder) {
      return json({ error: 'Folder not found' }, { status: 404 })
    }
    
    if (folder.is_default) {
      return json({ error: 'Cannot delete default folder' }, { status: 400 })
    }
    
    const deleteSessions = url.searchParams.get('deleteSessions') === 'true'
    // BL-388: the dialog sends the ids of the chats it showed (`GET .../sessions`); the delete
    // selects by the same rule and deletes nothing when the folder holds anything else now.
    let expectedSessionIds: string[] = []
    if (deleteSessions) {
      const body = await request.json().catch(() => null)
      const ids = body?.expectedChatIds
      if (!Array.isArray(ids) || !ids.every((id: unknown) => typeof id === 'string')) {
        return json(
          { error: 'The delete must name the chats it was shown (expectedChatIds).' },
          { status: 400 }
        )
      }
      expectedSessionIds = ids
    }
    // Each chat goes the way the session route deletes one: its running reply is stopped first
    // and the chat is swept once that reply's request is done (`sessionDeleteTurnStop.ts`).
    const result = await redis.deleteFolder(
      userId,
      folderId,
      deleteSessions
        ? { deleteSessions: true, deleteSession: deleteSessionStoppingItsTurn, expectedSessionIds }
        : {}
    )
    
    if (!result.success && (result.code === 'folder_delete_stopped' || result.code === 'folder_not_empty')) {
      return folderDeleteStoppedAnswer(result)
    }

    if (!result.success) {
      const status =
        result.code === FOLDER_CHANGED_CODE || result.error?.includes('locked') ? 409 : 500
      return json(
        { error: result.error || 'Failed to delete folder', ...(result.code ? { code: result.code } : {}) },
        { status }
      )
    }
    
    return json(result)
  } catch (error) {
    // A chat in the folder whose reply did not stop in time is not deleted, nor is the folder;
    // the chats before it are gone, and a retry finishes the rest (`sessionDeleteTurnStop.ts`).
    if (error instanceof SessionDeleteRefusedError) {
      return json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error('Error deleting folder:', error)
    return json({ error: 'Failed to delete folder' }, { status: 500 })
  }
}
