/**
 * BL-369: the error `skillRegistry` throws for a user skill whose folder is missing
 * (`SkillFilesMissingError`), recognized by its code so a route can answer 409 with the reason
 * instead of a generic 500. Its own module on purpose: route tests replace `skillRegistry` with
 * a mock, and a check that lived there would disappear with it.
 */
export const SKILL_FILES_MISSING = 'SKILL_FILES_MISSING'

export function isSkillFilesMissingError(error: unknown): error is Error & { code: typeof SKILL_FILES_MISSING } {
  return error instanceof Error && (error as { code?: unknown }).code === SKILL_FILES_MISSING
}
