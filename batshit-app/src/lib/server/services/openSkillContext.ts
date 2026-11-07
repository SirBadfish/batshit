import { createHash } from 'node:crypto'
import { buildOpenSkillToolHints, type AllowedSkillToolHint, type OpenSkillToolGroups } from '$lib/utils/skillToolGroups'
import { buildOpenSkillsDcmLines, type OpenSkillSession } from '$lib/utils/skillSessions'
import { readOpenSkillSessions, type SkillSessionActor } from './skillSessions'
import { builtinPluginSkill } from './agentPlugins'
import { resolveSkillAccessForActor } from './slashCommandCapabilities'
import { readBuiltinSkillToolGroups } from './systemPluginPackage'
import { COMPILED_TAG, compiledElement, disarmCompiledTags } from '$lib/utils/compiledChatTags'

export interface OpenSkillToolIndex {
  allowedSkillToolHints?: readonly AllowedSkillToolHint[]
  completeFeatureHintRefs?: readonly string[]
}

/** Only the compiler-owned section slot; a captured prefix is exact, never searched. */
export function replaceOpenSkillSectionBody(body: string, before: string, after: string, prefix = ''): string {
  if (prefix) {
    if (body !== prefix && !body.startsWith(`${prefix}\n\n`)) {
      throw new Error('The original skill context prefix changed. Nothing was sent.')
    }
    const rest = body === prefix ? '' : body.slice(prefix.length + 2)
    return [prefix, replaceOpenSkillSectionBody(rest, before, after)].filter(Boolean).join('\n\n')
  }
  if (before && body !== before && !body.startsWith(`${before}\n`)) {
    throw new Error('The original open skill context span changed. Nothing was sent.')
  }
  const rest = before ? body.slice(before.length).replace(/^\n/, '') : body
  return [after, rest].filter(Boolean).join('\n')
}

export function replaceOpenSkillSectionInDcm(dcm: string, before: string, after: string, prefix = ''): string {
  if (before === after) return dcm
  if (!dcm) {
    if (before) throw new Error('The original open skill context is missing. Nothing was sent.')
    return after ? compiledElement(COMPILED_TAG.dynamicInfo, after) : ''
  }
  const start = `<${COMPILED_TAG.dynamicInfo}>\n`
  const end = `\n</${COMPILED_TAG.dynamicInfo}>`
  if (!dcm.startsWith(start) || !dcm.endsWith(end)) throw new Error('The canonical dynamic context is unavailable. Nothing was sent.')
  const body = replaceOpenSkillSectionBody(dcm.slice(start.length, -end.length), before, after, prefix)
  return body ? compiledElement(COMPILED_TAG.dynamicInfo, body) : ''
}

/** One read-only formatter for the canonical section and its ephemeral delivery. No skill body. */
export async function buildOpenSkillContext(input: {
  actor: SkillSessionActor
  toolIndex: OpenSkillToolIndex
  skills?: readonly OpenSkillSession[]
  /** Only the compiler's provisional API pass; actual registration must replace this before send. */
  allowUnprepared?: boolean
}) {
  const skills = input.skills ?? await readOpenSkillSessions(input.actor)
  const scopes: OpenSkillToolGroups[] = []
  const availability = new Map<string, string>()
  for (const skill of skills) {
    if (!builtinPluginSkill(skill.skillId)) continue
    const access = await resolveSkillAccessForActor(input.actor.userId, skill.skillId,
      { kind: 'agent', agentId: input.actor.agentId }, { readOnly: true })
    if (!access.ok) { availability.set(skill.skillId, `skill_access: ${access.code}`); continue }
    // Matching an id is not package ownership: an existing independent skill may collide
    // with a newly introduced built-in id without acquiring its guidance or access policy.
    if (access.command.plugin_id !== 'batshit') continue
    scopes.push({ skillId: skill.skillId, toolGroups: readBuiltinSkillToolGroups(skill.skillId) })
  }
  if (scopes.some(scope => scope.toolGroups.length) && !Array.isArray(input.toolIndex.allowedSkillToolHints) && !input.allowUnprepared) {
    throw new Error('Open skill tool guidance is not prepared. Nothing was sent.')
  }
  const hints = buildOpenSkillToolHints(scopes, input.toolIndex.allowedSkillToolHints ?? [],
    new Set(input.toolIndex.completeFeatureHintRefs ?? []))
  const text = disarmCompiledTags(buildOpenSkillsDcmLines(skills, hints, availability).join('\n'))
  const lines = text ? text.split('\n') : []
  // Equality/cache identity only. Delivery ordering has its own run-bound monotonic sequence.
  const fingerprint = createHash('sha256').update(JSON.stringify({ actor: input.actor,
    skills: skills.map(({ skillId, generation, revision }) => ({ skillId, generation, revision })), text })).digest('hex')
  return { skills, lines, text, fingerprint }
}
