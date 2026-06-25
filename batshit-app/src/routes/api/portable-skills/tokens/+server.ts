import { json, type RequestHandler } from '@sveltejs/kit'
import {
  createPortableSkillToken,
  ensurePortableSkillEnvTemplates,
  getPortableSkillFamilyDefinitions,
  listPortableSkillTokens
} from '$lib/server/services/portableSkillTokens'

function errorStatus(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }

  try {
    const tokens = await listPortableSkillTokens(locals.user.id)
    const envTemplates = await ensurePortableSkillEnvTemplates()
    return json({
      success: true,
      tokens,
      families: getPortableSkillFamilyDefinitions(),
      envTemplates
    })
  } catch (error) {
    console.error('[Portable Skills] failed to list tokens:', error)
    return json(
      { success: false, error: errorMessage(error, 'Failed to list Portable Skill Tokens.') },
      { status: errorStatus(error) }
    )
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }

  try {
    const body = (await request.json().catch(() => null)) as
      | { label?: unknown; families?: unknown }
      | null
    if (!body || typeof body !== 'object') {
      return json({ success: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const result = await createPortableSkillToken({
      userId: locals.user.id,
      label: body.label,
      families: body.families
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
    console.error('[Portable Skills] failed to create token:', error)
    return json(
      { success: false, error: errorMessage(error, 'Failed to create Portable Skill Token.') },
      { status: errorStatus(error) }
    )
  }
}
