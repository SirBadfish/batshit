import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { requireAdmin } from '$lib/server/services/routeSecurity'

export const GET: RequestHandler = async ({ url, locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  const key = url.searchParams.get('key')
  
  if (!key) {
    return json({ error: 'Key parameter is required' }, { status: 400 })
  }

  try {
    const value = await redis.get(key)
    
    if (value === null) {
      return json({ value: null })
    }

    // Try to parse as JSON if it looks like JSON
    let parsedValue = value
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      try {
        parsedValue = JSON.parse(value)
      } catch {
        // Not JSON, return as string
      }
    }

    return json({ value: parsedValue })
  } catch (error) {
    console.error('[Redis GET API] Error:', error)
    return json({ error: 'Failed to fetch from Redis' }, { status: 500 })
  }
}
