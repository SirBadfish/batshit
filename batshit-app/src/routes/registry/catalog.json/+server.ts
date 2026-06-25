import { json } from '@sveltejs/kit'
import { upstashKvGet } from '$lib/server/services/upstashKv'

const CACHE_SECONDS = 60 * 5 // 5 minutes

async function fetchFromUpstash() {
  return upstashKvGet('catalog:v1', { allowWriteTokenFallback: false })
}

export const GET = async () => {
  try {
    const catalog = await fetchFromUpstash()
    if (!catalog) {
      return json({ error: 'Catalog not found' }, { status: 404 })
    }

    return new Response(JSON.stringify(catalog), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`
      }
    })
  } catch (error: any) {
    console.error('[registry] Failed to load catalog:', error)
    return json({ error: 'Failed to load model catalog' }, { status: 500 })
  }
}
