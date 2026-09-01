import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { resolveProviderAccess } from '$lib/server/services/providers'
import { invalidateUserSettingsCache } from '$lib/services/databaseRedis.server'

const CHAT_PROVIDER_LABELS = new Map<string, string>([
  ['ai_gateway', 'Vercel AI Gateway'],
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['google', 'Google'],
  ['mistral', 'Mistral'],
  ['groq', 'Groq'],
  ['xai', 'xAI'],
  ['deepseek', 'DeepSeek'],
  ['moonshot', 'Moonshot AI'],
  ['minimax', 'MiniMax'],
  ['mimo', 'MiMo'],
  ['qwencloud', 'Qwen Cloud'],
  ['qwen_token_plan', 'Qwen Token Plan'],
  ['alibaba', 'Alibaba Cloud'],
  ['stepfun', 'StepFun'],
  ['zai', 'Z.ai General'],
  ['zai_coding', 'Z.ai Coding Plan'],
  ['openrouter', 'OpenRouter'],
  ['deepinfra', 'DeepInfra'],
  ['togetherai', 'Together.ai'],
  ['fireworks', 'Fireworks AI'],
  ['baseten', 'Baseten'],
  ['cerebras', 'Cerebras']
])

type OnboardingAction = 'complete' | 'skip'

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function buildStatus(userId: string) {
  const [providerAccess, modelIds, agents, settings] = await Promise.all([
    resolveProviderAccess(userId),
    redis.execute((client) => client.sMembers(`user:${userId}:models`)),
    redis.getAgents(userId),
    redis.getUserSettings(userId)
  ])

  const readyKeys = Array.from(CHAT_PROVIDER_LABELS.entries())
    .map(([id, label]) => {
      if (id === 'ai_gateway') {
        const availability = providerAccess.gateway.availability
        return availability.hasKey
          ? { id, label, source: availability.source ?? 'unknown' }
          : null
      }

      const availability = providerAccess.availability[id as keyof typeof providerAccess.availability]
      return availability?.hasKey
        ? { id, label, source: availability.source ?? 'unknown' }
        : null
    })
    .filter((entry): entry is { id: string; label: string; source: string } => Boolean(entry))

  const onboarding = isObject((settings as any)?.onboarding_settings)
    ? (settings as any).onboarding_settings
    : {}
  const completedAt =
    typeof onboarding.setup_completed_at === 'string' ? onboarding.setup_completed_at : null
  const skippedAt =
    typeof onboarding.setup_skipped_at === 'string' ? onboarding.setup_skipped_at : null

  return {
    apiKeys: {
      readyCount: readyKeys.length,
      readyKeys
    },
    modelPresets: {
      count: modelIds.length
    },
    agents: {
      count: agents.length
    },
    onboarding: {
      completedAt,
      skippedAt,
      finished: Boolean(completedAt || skippedAt),
      shouldShow: !completedAt && !skippedAt && (agents.length === 0 || modelIds.length === 0)
    }
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    return json(await buildStatus(locals.user.id))
  } catch (error) {
    console.error('[Onboarding] Failed to build status:', error)
    return json({ error: 'Failed to load setup status' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const action = body?.action as OnboardingAction
    if (action !== 'complete' && action !== 'skip') {
      return json({ error: 'Action must be complete or skip' }, { status: 400 })
    }

    const existing = await redis.getUserSettings(locals.user.id)
    const previous = isObject((existing as any)?.onboarding_settings)
      ? (existing as any).onboarding_settings
      : {}
    const now = new Date().toISOString()
    const onboarding_settings = {
      ...previous,
      ...(action === 'complete'
        ? { setup_completed_at: now, setup_skipped_at: null }
        : { setup_skipped_at: now })
    }

    const settings = await redis.updateUserSettings(locals.user.id, {
      onboarding_settings
    })
    invalidateUserSettingsCache(locals.user.id)

    return json({
      success: true,
      settings,
      status: await buildStatus(locals.user.id)
    })
  } catch (error) {
    console.error('[Onboarding] Failed to update status:', error)
    return json({ error: 'Failed to update setup status' }, { status: 500 })
  }
}
