import { json, type RequestHandler } from '@sveltejs/kit'
import {
  ensurePortableSkillEnvTemplates,
  getPortableSkillFamilyDefinitions,
  rotatePortableSkillToken
} from '$lib/server/services/portableSkillTokens'

function errorStatus(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const tokenId = params.id
  if (!tokenId) {
    return json({ success: false, error: 'Token id is required.' }, { status: 400 })
  }

  try {
    const result = await rotatePortableSkillToken({
      userId: locals.user.id,
      tokenId
    })
    const envTemplates = await ensurePortableSkillEnvTemplates()

    return json({
      success: true,
      token: result.token,
      record: result.record,
      families: getPortableSkillFamilyDefinitions(),
      envTemplates
    })
  } catch (error) {
    console.error('[Portable Skills] failed to rotate token:', error)
    return json(
      { success: false, error: errorMessage(error, 'Failed to rotate Portable Skill Token.') },
      { status: errorStatus(error) }
    )
  }
}
