import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { checkCoreSystemPromptDefaults } from '$lib/server/services/systemPromptRegistry'

export const GET: RequestHandler = async () => {
  try {
    const [pong, systemPromptDefaults] = await Promise.all([
      redis.ping(),
      checkCoreSystemPromptDefaults()
    ])
    const redisReady = pong === 'PONG'
    const ok = redisReady && systemPromptDefaults.ready

    return json(
      {
        ok,
        service: 'batshit-app',
        checks: {
          http: true,
          redis: redisReady,
          systemPromptDefaults: systemPromptDefaults.ready
        },
        systemPromptDefaults
      },
      { status: ok ? 200 : 503 }
    )
  } catch (error) {
    return json(
      {
        ok: false,
        service: 'batshit-app',
        checks: {
          http: true,
          redis: false,
          systemPromptDefaults: false
        },
        error: error instanceof Error ? error.message : 'Redis health check failed'
      },
      { status: 503 }
    )
  }
}
