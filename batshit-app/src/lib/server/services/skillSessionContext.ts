import { apiKeyService } from '$lib/services/apiKey.server'

const SKILL_INVOCATION_MARKER_REGEX = /\[Skill:\s*[^\]\n]+?\|\s*skillId=[^\]\n]+\]/i

function normalizeServiceList(services: string[]): string {
  const normalized = services
    .map((service) => service.trim().toLowerCase())
    .filter(Boolean)
    .sort()

  return normalized.length > 0 ? normalized.join(', ') : '(none)'
}

export function isSkillInvocationMessage(message: string | null | undefined): boolean {
  if (typeof message !== 'string') return false
  return SKILL_INVOCATION_MARKER_REGEX.test(message)
}

export function buildSkillApiKeyAvailabilityLines(availability: {
  configured: string[]
  notConfigured: string[]
}): string[] {
  return [
    'skill_session_context:',
    '- current_skill_invocation: yes',
    '- Saved third-party credential availability is non-secret status only, not permission to use a key.',
    '- If a saved external key is needed, tell the user what is available and ask before using it.',
    `user_api_keys_configured: ${normalizeServiceList(availability.configured)}`,
    `user_api_keys_not_configured: ${normalizeServiceList(availability.notConfigured)}`
  ]
}

export async function buildSkillSessionContextLines(options: {
  userId?: string | null
  currentUserMessage?: string | null
}): Promise<string[]> {
  const userId = options.userId?.trim()
  if (!userId) return []
  if (!isSkillInvocationMessage(options.currentUserMessage)) return []

  const availability = await apiKeyService.getApiKeyAvailability(userId)
  return buildSkillApiKeyAvailabilityLines(availability)
}
