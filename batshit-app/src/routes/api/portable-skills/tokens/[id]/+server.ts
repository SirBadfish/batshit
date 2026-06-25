import { json, type RequestHandler } from '@sveltejs/kit'
import {
  ensurePortableSkillEnvTemplates,
  getPortableSkillFamilyDefinitions,
  revokePortableSkillToken,
  updatePortableSkillToken
} from '$lib/server/services/portableSkillTokens'

function errorStatus(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const tokenId = params.id
  if (!tokenId) {
    return json({ success: false, error: 'Token id is required.' }, { status: 400 })
  }

  try {
    const body = (await request.json().catch(() => null)) as
      | { label?: unknown; families?: unknown }
      | null
    if (!body || typeof body !== 'object') {
      return json({ success: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const record = await updatePortableSkillToken({
      userId: locals.user.id,
      tokenId,
      label: body.label,
      families: body.families
    })
    const envTemplates = await ensurePortableSkillEnvTemplates()

    return json({
      success: true,
      record,
      families: getPortableSkillFamilyDefinitions(),
      envTemplates
    })
  } catch (error) {
    console.error('[Portable Skills] failed to update token:', error)
    return json(
      { success: false, error: errorMessage(error, 'Failed to update Portable Skill Token.') },
      { status: errorStatus(error) }
    )
  }
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const tokenId = params.id
  if (!tokenId) {
    return json({ success: false, error: 'Token id is required.' }, { status: 400 })
  }

  try {
    const record = await revokePortableSkillToken({
      userId: locals.user.id,
      tokenId
    })
    const envTemplates = await ensurePortableSkillEnvTemplates()

    return json({
      success: true,
      record,
      families: getPortableSkillFamilyDefinitions(),
      envTemplates
    })
  } catch (error) {
    console.error('[Portable Skills] failed to revoke token:', error)
    return json(
      { success: false, error: errorMessage(error, 'Failed to revoke Portable Skill Token.') },
      { status: errorStatus(error) }
    )
  }
}
