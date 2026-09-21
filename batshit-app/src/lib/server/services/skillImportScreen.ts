/**
 * SA-120 P7 — the Jev Juice incoming-text screen, applied to a skill at import.
 *
 * Both import doors call this AFTER `importSkillDefinition` has fetched and parsed the skill:
 * Settings → Skills & Commands (`POST /api/skills/import`, where the user then reads the
 * result in the import dialog before saving anything) and the `sys.skill.import` control
 * (which has already passed the user's Approve click and saves the skill as it always did).
 *
 * ADVISORY ONLY (DL-120-12): it runs after the risk gate, feeds nothing back into it, and
 * changes nothing about the import: not the trust level, not what is saved, not whether it is
 * saved. Only SKILL.md is read, because that is the text an agent later takes as instructions;
 * bundled scripts and references are not screened, and the dialog's own warnings still say so.
 *
 * With **Screen Incoming Text** (on the Jev Juice card) off it returns `null`: no call, no field, today's
 * response bytes.
 */

import type { UntrustedTextScreen } from '$lib/types/typesafe'
import { attachTypesafeRecordToActiveStream } from './typesafe/typesafeRunEvidence'
import { agentFindingList, screenUntrustedText } from './untrustedText.jev'

export interface ImportedSkillText {
  name?: string | null
  description?: string | null
  markdown?: string | null
}

export async function screenImportedSkill(options: {
  userId: string
  skill: ImportedSkillText
  /** The chat whose running turn asked for the import (the `sys.skill.import` door), for the Execution Viewer row. */
  evidenceSessionId?: string | null
}): Promise<UntrustedTextScreen | null> {
  const screen = await screenUntrustedText({
    userId: options.userId,
    source: 'skill',
    text: options.skill.markdown ?? '',
    skillName: options.skill.name ?? null,
    skillDescription: options.skill.description ?? null
  })
  if (screen && options.evidenceSessionId) {
    await attachTypesafeRecordToActiveStream(
      options.evidenceSessionId,
      screen.record,
      'the incoming-text screen (a skill import)'
    )
  }
  return screen
}

/**
 * One plain warning line for a flagged skill, in the list every import already returns. `null`
 * for anything but a flag: "no flag" is never a line, because a missing flag proves nothing.
 */
export function buildSkillScreenWarning(screen: UntrustedTextScreen | null | undefined): string | null {
  if (!screen || screen.status !== 'flagged' || screen.findings.length === 0) return null
  return `Jev Juice flagged SKILL.md (an advisory guess; nothing was blocked): ${agentFindingList(screen)}. Read the skill before you trust it.`
}
