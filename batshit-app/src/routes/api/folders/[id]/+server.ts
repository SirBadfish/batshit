import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { ChatFolderRow } from '$lib/types/database'

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

// DELETE /api/folders/{id} - Delete folder.
// Default behavior moves chats to the default folder. Add ?deleteSessions=true
// to permanently delete the folder's sessions instead.
export const DELETE: RequestHandler = async ({ params, locals, url }) => {
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
    const result = await redis.deleteFolder(userId, folderId, { deleteSessions })
    
    if (!result.success) {
      const status = result.error?.includes('locked') ? 409 : 500
      return json({ error: result.error || 'Failed to delete folder' }, { status })
    }
    
    return json(result)
  } catch (error) {
    console.error('Error deleting folder:', error)
    return json({ error: 'Failed to delete folder' }, { status: 500 })
  }
}
