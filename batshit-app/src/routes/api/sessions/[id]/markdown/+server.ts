import { apiError } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { buildTranscriptMarkdown } from '$lib/utils/chatMarkdown'

function slugifyFilename(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'chat-transcript'
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
  if (!locals.user?.id) {
    return apiError('Unauthorized', 401)
  }

  const userId = locals.user.id
  const toolResultMode = url.searchParams.get('toolResults') === 'summary' ? 'summary' : 'full'

  try {
    const sessions = await redis.getSessions(userId, true)
    const session = sessions.find((entry) => entry.id === params.id)

    if (!session) {
      return apiError('Session not found', 404)
    }

    const [messages, agents, userSettings] = await Promise.all([
      redis.getSessionMessages(session.id),
      redis.getAgents(userId),
      redis.getUserSettings(userId)
    ])

    const agentsById = Object.fromEntries(
      agents.map((agent) => [agent.id, agent.displayName || 'Assistant'])
    )

    const markdown = await buildTranscriptMarkdown(
      {
        session,
        messages,
        agentsById,
        userLabel: userSettings?.displayName || 'User',
        assistantLabel: 'Assistant',
        toolResultMode
      },
      {
        resolveZip: async (zipId) => {
          try {
            return await redis.getZip(zipId)
          } catch (error) {
            console.error('Failed to load zip for session markdown:', error)
            return null
          }
        },
        resolveClip: async (clipId) => {
          try {
            const userClip = await redis.get(`clip:${userId}:${clipId}`)
            if (userClip) return userClip as any

            const systemClip = await redis.get(`clip:system:${clipId}`)
            return systemClip ? (systemClip as any) : null
          } catch (error) {
            console.error('Failed to load clip for session markdown:', error)
            return null
          }
        }
      }
    )

    const filename = `${slugifyFilename(session.name || session.id)}.md`

    return new Response(markdown, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'no-store'
      }
    })
  } catch (error) {
    console.error('Failed to build session markdown transcript:', error)
    return apiError('Failed to build markdown transcript', 500)
  }
}
