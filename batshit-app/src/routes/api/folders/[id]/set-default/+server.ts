import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'

// POST /api/folders/{id}/set-default - Set a folder as the default
export const POST: RequestHandler = async ({ params, locals }) => {
  const userId = locals.session?.user_id || locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const newDefaultFolderId = params.id
  
  try {
    // Verify the folder exists and belongs to the user
    const folder = await redis.getFolder(userId, newDefaultFolderId)
    
    if (!folder) {
      return json({ error: 'Folder not found' }, { status: 404 })
    }
    
    // Get all folders for the user
    const folders = await redis.getFolders(userId)
    
    // Update all folders - remove is_default from all, then set on the new one
    for (const f of folders) {
      if (f.id === newDefaultFolderId) {
        // Set this folder as default
        await redis.updateFolder(userId, f.id, { is_default: true })
      } else if (f.is_default) {
        // Remove default status from the old default folder
        await redis.updateFolder(userId, f.id, { is_default: false })
      }
    }
    
    // Update the user's default folder reference
    await redis.setDefaultFolder(userId, newDefaultFolderId)
    
    return json({ success: true, defaultFolderId: newDefaultFolderId })
  } catch (error) {
    console.error('Error setting default folder:', error)
    return json({ error: 'Failed to set default folder' }, { status: 500 })
  }
}