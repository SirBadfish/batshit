import { timingSafeEqual } from 'crypto'
import { env } from '$env/dynamic/private'
import { validateN8nScopedCallbackRequest } from '$lib/server/services/n8nCallbackTokens'
import {
  PORTABLE_SKILL_TOKEN_HEADER,
  validatePortableSkillToken
} from '$lib/server/services/portableSkillTokens'
import type { PortableSkillTokenSummary } from '$lib/types/portableSkills'

type NativeToolAuthMethod = 'service' | 'session' | 'n8n-callback' | 'portable-skill'

function tokenMatches(expected: string | null | undefined, actual: string): boolean {
  const normalizedExpected = expected?.trim()
  const normalizedActual = actual.trim()
  if (!normalizedExpected || !normalizedActual) return false

  try {
    const a = Buffer.from(normalizedExpected)
    const b = Buffer.from(normalizedActual)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

async function validateServiceToken(request: Request, claimedUserId?: string | null) {
  const serviceToken =
    request.headers.get('x-batshit-service-token')?.trim() ||
    request.headers.get('x-batshit-token')?.trim()
  const rawUserId = request.headers.get('x-batshit-user-id') || claimedUserId

  if (!serviceToken || !rawUserId) return { valid: false as const }

  const normalizedUserId = rawUserId.toLowerCase()

  if (tokenMatches(env.BATSHIT_TOKEN, serviceToken)) {
    return {
      valid: true as const,
      userId: normalizedUserId
    }
  }

  return { valid: false as const }
}

export async function resolveNativeToolUser(options: {
  request: Request
  localsUserId?: string | null
  claimedUserId?: string | null
  payload?: unknown
}): Promise<{
  userId: string
  auth: NativeToolAuthMethod
  projectPath?: string | null
  portableSkillToken?: PortableSkillTokenSummary
  portableSkillAllowedControlIds?: string[]
} | null> {
  const service = await validateServiceToken(options.request, options.claimedUserId)
  if (service.valid) {
    return {
      userId: service.userId,
      auth: 'service'
    }
  }

  const n8nCallback = await validateN8nScopedCallbackRequest(
    options.request,
    options.payload,
    options.claimedUserId
  )
  if (n8nCallback.valid) {
    return {
      userId: n8nCallback.userId,
      auth: 'n8n-callback',
      projectPath: n8nCallback.projectPath
    }
  }

  const portableSkill = await validatePortableSkillToken(
    options.request.headers.get(PORTABLE_SKILL_TOKEN_HEADER)
  )
  if (portableSkill.valid) {
    return {
      userId: portableSkill.userId,
      auth: 'portable-skill',
      portableSkillToken: portableSkill.token,
      portableSkillAllowedControlIds: portableSkill.allowedControlIds
    }
  }

  if (options.localsUserId) {
    return {
      userId: options.localsUserId,
      auth: 'session'
    }
  }

  return null
}
