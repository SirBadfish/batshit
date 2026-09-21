import { json, type RequestHandler } from '@sveltejs/kit'
import {
  importSkillDefinition,
  toImportErrorResponse,
  type SkillImportInput
} from '$lib/server/services/skillImport'
import { screenImportedSkill } from '$lib/server/services/skillImportScreen'

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json().catch(() => ({}))) as SkillImportInput
    const result = await importSkillDefinition(body)

    // SA-120 P7: with **Screen Incoming Text** (on the Jev Juice card) on, SKILL.md is shown to Jev once and
    // the answer rides the response as `jevJuiceScreen`, which the import dialog draws as its
    // own block. Advisory only: the import result is exactly what it was, and nothing is saved
    // until the user saves the form. Off: `null`, and the response is today's bytes.
    const screen = await screenImportedSkill({ userId: locals.user.id, skill: result.skill })
    return json(screen ? { ...result, jevJuiceScreen: screen } : result)
  } catch (error) {
    const failure = toImportErrorResponse(error)
    return json({ error: failure.message }, { status: failure.status })
  }
}
