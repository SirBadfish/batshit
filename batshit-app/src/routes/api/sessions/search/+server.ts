import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'

// GET /api/sessions/search?q=query
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const query = url.searchParams.get('q') || ''

    // Get all user sessions
    const sessions = await redis.getSessions(locals.user.id)

    // Filter sessions by query (search in name and other fields)
    const filtered = sessions.filter((session: any) => {
      const searchable = `${session.name || ''} ${session.description || ''}`.toLowerCase()
      return searchable.includes(query.toLowerCase())
    })

    return json(filtered)
  } catch (error) {
    console.error('Error searching sessions:', error)
    return json([])
  }
}