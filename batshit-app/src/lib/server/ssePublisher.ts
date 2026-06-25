import { redis } from './redis'

const CHANNEL_PREFIX = 'batshit:sse:'

export async function publishSessionEvent(sessionId: string, event: Record<string, any>) {
  if (!sessionId) return

  const payload = JSON.stringify({
    sessionId,
    ...event
  })

  await redis.execute(async (client) => {
    await client.publish(`${CHANNEL_PREFIX}${sessionId}`, payload)
  })
}

export function getSessionChannel(sessionId: string) {
  return `${CHANNEL_PREFIX}${sessionId}`
}
