import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'

import { redis } from '$lib/server/redis'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { nativeToolService, resolveNativeToolSettings } from '$lib/server/services/nativeTools'

interface AgentBrowserRequest {
  userId?: string
  agentId?: string
  sessionId?: string
  action?: 'find' | 'use'
  query?: string
  limit?: number
  toolName?: string
  params?: Record<string, unknown>
}

function buildAgentBrowserSettings(providerSettings: Record<string, any> | null) {
  const settings = resolveNativeToolSettings(providerSettings)
  return {
    enabled: settings.agentBrowserEnabled,
    runtime: {
      liveViewEnabled: settings.agentBrowserLiveViewEnabled,
      runtimeMode: settings.agentBrowserRuntimeMode,
      cdpPort: settings.agentBrowserCdpPort,
      provider: settings.agentBrowserProvider,
      executablePath: settings.agentBrowserExecutablePath,
      extraFlags: settings.agentBrowserExtraFlags,
      timeoutMs: settings.agentBrowserTimeoutMs
    }
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as AgentBrowserRequest | null
    if (!body || typeof body !== 'object') {
      return json({ success: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null,
      claimedUserId: body.userId ?? null
    })

    if (!auth) {
      return apiFailure('Unauthorized', 401)
    }

    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
    if (!agentId) {
      return json({ success: false, error: 'agentId is required.' }, { status: 400 })
    }

    const agent = (await redis.get(`agent:${agentId}`)) as
      | (Record<string, any> & { user_id?: string; provider_specific_settings?: Record<string, any> | null })
      | null
    if (!agent || agent.user_id !== auth.userId) {
      return json({ success: false, error: 'Agent not found.' }, { status: 404 })
    }

    const resolved = buildAgentBrowserSettings(agent.provider_specific_settings ?? null)
    if (!resolved.enabled) {
      return json(
        {
          success: false,
          error: 'Agent Browser is disabled in Agent Settings for this agent.'
        },
        { status: 403 }
      )
    }

    if (body.action === 'find') {
      const result = await nativeToolService.nativeAgentBrowserFind({
        userId: auth.userId,
        query: typeof body.query === 'string' ? body.query : undefined,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
        settings: resolved.runtime
      })
      return json(result, { status: result.dockerUnsupported === true ? 503 : 200 })
    }

    if (body.action === 'use') {
      const toolName = typeof body.toolName === 'string' ? body.toolName.trim() : ''
      if (!toolName) {
        return json({ success: false, error: 'toolName is required.' }, { status: 400 })
      }

      const result = await nativeToolService.nativeAgentBrowserUse({
        userId: auth.userId,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        toolName,
        params:
          body.params && typeof body.params === 'object' && !Array.isArray(body.params)
            ? body.params
            : undefined,
        settings: resolved.runtime
      })
      return json(result, { status: result.dockerUnsupported === true ? 503 : 200 })
    }

    return json({ success: false, error: 'action must be `find` or `use`.' }, { status: 400 })
  } catch (error) {
    console.error('[Native Tools] agent-browser failed:', error)
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Agent Browser request failed.'
      },
      { status: 500 }
    )
  }
}
