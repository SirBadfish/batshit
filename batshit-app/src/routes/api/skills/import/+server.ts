import { json, type RequestHandler } from '@sveltejs/kit'
import {
  importSkillDefinition,
  toImportErrorResponse,
  type SkillImportInput
} from '$lib/server/services/skillImport'

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json().catch(() => ({}))) as SkillImportInput
    const result = await importSkillDefinition(body)
    return json(result)
  } catch (error) {
    const failure = toImportErrorResponse(error)
    return json({ error: failure.message }, { status: failure.status })
  }
}
