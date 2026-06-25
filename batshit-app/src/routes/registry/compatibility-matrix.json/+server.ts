import { json } from '@sveltejs/kit'
import { upstashKvGet } from '$lib/server/services/upstashKv'

const CACHE_SECONDS = 60 * 5 // 5 minutes

async function fetchFromUpstash() {
  return upstashKvGet('compatibility-matrix:v1', { allowWriteTokenFallback: false })
}

export const GET = async () => {
  try {
    const matrix = await fetchFromUpstash()
    if (!matrix) {
      return json({ error: 'Compatibility matrix not found' }, { status: 404 })
    }

    return new Response(JSON.stringify(matrix), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`
      }
    })
  } catch (error: any) {
    console.error('[registry] Failed to load compatibility matrix:', error)
    return json({ error: 'Failed to load compatibility matrix' }, { status: 500 })
  }
}
