import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { ChatFolderRow } from '$lib/types/database'

// GET /api/folders - List all user's folders
export const GET: RequestHandler = async ({ locals }) => {
  // Check both session and user for authentication
  const userId = locals.session?.user_id || locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const folders = await redis.getFolders(userId)
    return json(folders)
  } catch (error) {
    console.error('Error fetching folders:', error)
    return json({ error: 'Failed to fetch folders' }, { status: 500 })
  }
}

// POST /api/folders - Create new folder
export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.session?.user_id || locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const data = await request.json()
    const { name, sort_order } = data
    
    if (!name) {
      return json({ error: 'Folder name is required' }, { status: 400 })
    }
    
    // Generate unique folder ID
    const folderId = crypto.randomUUID()
    
    // Create folder object
    const now = new Date().toISOString()
    const folder: ChatFolderRow = {
      id: folderId,
      user_id: userId,
      name,
      is_default: false,
      is_expanded: true,
      sort_order: sort_order ?? 1,
      last_used_at: now,
      created_at: now,
      updated_at: now,
      chat_count: 0
    }
    
    // Store folder in database
    const createdFolder = await redis.createFolder(folder)
    
    return json(createdFolder)
  } catch (error) {
    console.error('Error creating folder:', error)
    return json({ error: 'Failed to create folder' }, { status: 500 })
  }
}
