/**
 * SA-120 P1 (design record B1 + B6) — Jev Juice skill and tool hints.
 *
 * THE constants module for this feature (DL-120-03): every question, criterion,
 * threshold, and cap lives here, so a reviewer reads the whole decision surface in one
 * file. Thresholds change in code review, never in a prompt.
 *
 * What it does, per accepted user turn on a PRIMARY API or managed CLI lane whose agent
 * has "Jev Juice: Suggest Skills and Tools" ON:
 *   1. one Jev request with up to five parallel questions — an action gate, a Choice
 *      over the agent's enabled skills, a Choice over its discoverable typed refs, and
 *      a Choice plus a Noul over the capabilities it does NOT have;
 *   2. code applies the floors below and writes at most three soft lines at the end of
 *      the DCM ("ignore any that do not fit");
 *   3. a confident capability gap also becomes a chip on the assistant message that
 *      names the gap and links to the agent's settings — it never widens access (B6).
 *
 * Runs under the user's In-Chat Wait Limit (DL-120-05/16, 750 ms by default). A miss omits the lines, the send
 * proceeds, and the inline note says so (DL-120-02). Measured basis: the skill picker
 * probe (8/8 on the repo skills once the gate spoke Batshit's language: make, change,
 * run, test, set up) in the skill's evidence file.
 */

import type { JevJuiceGap, JevJuiceNote, TypesafeCallRecord } from '$lib/types/typesafe'
import type { AgentSlashCapability } from './slashCommandCapabilities'
import { listAllSlashCapabilities } from './slashCommandCapabilities'
import type { DynamicMcpDiscoverableRef } from './dynamicMcpIndex'
import { listCliTools } from './cliToolRegistry'
import { mcpGatewayService } from './mcpGatewayService'
import { resolveNativeToolSettings } from './nativeTools'
import { runTypesafeJudgment } from './typesafe/typesafeAvailability'
import type {
  JevChoiceAnswer,
  JevChoiceQuestion,
  JevNoulAnswer,
  JevNoulQuestion,
  JevQuestions,
  TypesafeClient
} from './typesafe/typesafeClient'
import { buildJevJuiceNote } from './typesafe/typesafeEvidence'

export const SKILL_TOOL_HINTS_FEATURE_ID = 'skill_tool_hints' as const

/** The floors code applies to Jev's probabilities. Tuned against the labeled set (DL-120-09). */
export const SKILL_TOOL_HINT_THRESHOLDS = Object.freeze({
  /** The action gate: below this, the turn reads as conversation and no skill/tool hint is written. */
  needsActionFloor: 0.5,
  /** Top-option probability a skill needs before it becomes a hint line. */
  skillFloor: 0.55,
  /** Top-option probability a tool needs before it becomes a hint line. */
  toolFloor: 0.55,
  /** Top-option probability a missing capability needs before it becomes a line and a chip. */
  gapFloor: 0.65,
  /** The independent "needs something it does not have" Noul must also clear this. */
  gapNeededFloor: 0.6
})

export const SKILL_TOOL_HINT_LIMITS = Object.freeze({
  /** Vendor Choice cap is 255 (reliable to about 240); `none` takes one slot. */
  maxChoiceOptions: 240,
  /** The user message is the state; longer turns are cut here (about 1k tokens). */
  maxMessageChars: 4000,
  /**
   * One-line option descriptions. The live P1 proof (2026-09-16) sent 24k chars for one
   * agent — 44 Fabric controls with schema hints plus the gap catalog — and answered in
   * 522 ms, so field hints stay OUT of the Choice criteria (the winner's hint comes from
   * the candidate object, not from Jev) and descriptions are kept short.
   */
  maxDescriptionChars: 120,
  /** The gap catalog is small on purpose: native toggles, then skills, CLI tools, MCP sources. */
  maxGapCandidates: 60,
  /** Tool names quoted per MCP source in the gap catalog. */
  maxGatewayToolNames: 8
})

/** The exact instructions and criteria sent to Jev. Question ids are for code only. */
export const SKILL_TOOL_HINT_QUESTIONS = Object.freeze({
  needsAction: {
    instructions:
      'Does `message` ask the assistant to make, change, run, test, set up, find, fetch, save, or look something up — an action on the user\'s project, app, files, tools, memory, or the web — rather than only asking for an explanation, an opinion, or conversation?',
    criteria: {
      true: 'The user wants something done or produced: build, edit, run, test, configure, search, fetch, save, install, convert.',
      false: 'The user wants an explanation, an opinion, a chat, or a clarification, and nothing needs to be done in their project or tools.'
    }
  },
  skill: {
    instructions:
      'Which of these skills (step-by-step procedures the assistant can load) would an expert open before handling `message`? Pick `none` when no listed skill clearly fits or the request needs no procedure.',
    none: 'No listed skill fits, or the request needs no procedure.'
  },
  tool: {
    instructions:
      'Which of these tools would the assistant most likely need to call first to handle `message`? Pick `none` when the request needs no tool or none listed fits.',
    none: 'No tool is needed, or none listed fits.'
  },
  gap: {
    instructions:
      'Which of these capabilities, currently turned OFF for this assistant, would handling `message` require? Pick `none` when the request can be handled without any of them.',
    none: 'None of the missing capabilities is needed.'
  },
  gapNeeded: {
    instructions:
      'Does handling `message` require one of the `missing_capabilities` (things this assistant currently cannot do)?',
    criteria: {
      true: 'The request cannot be completed properly without one of the listed missing capabilities.',
      false: 'The request can be handled with what the assistant already has, or needs no capability at all.'
    }
  }
})

export interface SkillHintCandidate {
  invocation: string
  skillId: string | null
  description: string | null
}

export interface ToolHintCandidate {
  ref: string
  name: string
  family: DynamicMcpDiscoverableRef['family']
  description: string | null
  hint: string | null
  enabled: boolean
}

export interface GapCandidate {
  id: string
  kind: JevJuiceGap['kind']
  label: string
  what: string
}

export interface SkillToolHintInput {
  message: string
  agentName: string
  skills: SkillHintCandidate[]
  tools: ToolHintCandidate[]
  gaps: GapCandidate[]
}

export interface SkillToolHintRequest {
  state: { message: string; assistant: string; missing_capabilities?: Array<{ id: string; what: string }> }
  questions: JevQuestions
  skills: SkillHintCandidate[]
  tools: ToolHintCandidate[]
  gaps: GapCandidate[]
  truncated: { skills: boolean; tools: boolean; gaps: boolean }
}

function clip(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (!oneLine) return null
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine
}

function noul(instructions: string, criteria?: { true: string; false: string }): JevNoulQuestion {
  return { type: 'noul', instructions, ...(criteria ? { criteria } : {}) }
}

function choice(instructions: string, criteria: Record<string, unknown>): JevChoiceQuestion {
  return { type: 'choice', instructions, criteria }
}

/** Builds the one request, or `null` when there is nothing to pick from (no call is made then). */
export function buildSkillToolHintRequest(input: SkillToolHintInput): SkillToolHintRequest | null {
  const message = input.message.replace(/\s+$/, '').slice(0, SKILL_TOOL_HINT_LIMITS.maxMessageChars).trim()
  if (!message) return null

  const optionCap = SKILL_TOOL_HINT_LIMITS.maxChoiceOptions - 1
  const skills = input.skills.slice(0, optionCap)
  const tools = input.tools.slice(0, optionCap)
  const gaps = input.gaps.slice(0, SKILL_TOOL_HINT_LIMITS.maxGapCandidates)
  if (skills.length === 0 && tools.length === 0 && gaps.length === 0) return null

  const questions: JevQuestions = {
    needs_action: noul(SKILL_TOOL_HINT_QUESTIONS.needsAction.instructions, SKILL_TOOL_HINT_QUESTIONS.needsAction.criteria)
  }

  if (skills.length > 0) {
    const criteria: Record<string, unknown> = {}
    for (const skill of skills) {
      criteria[skill.invocation] = {
        what: clip(skill.description, SKILL_TOOL_HINT_LIMITS.maxDescriptionChars) ?? 'A skill with no description.'
      }
    }
    criteria.none = SKILL_TOOL_HINT_QUESTIONS.skill.none
    questions.skill = choice(SKILL_TOOL_HINT_QUESTIONS.skill.instructions, criteria)
  }

  if (tools.length > 0) {
    const criteria: Record<string, unknown> = {}
    for (const tool of tools) {
      const description = clip(tool.description, SKILL_TOOL_HINT_LIMITS.maxDescriptionChars)
      criteria[tool.ref] = { what: description ?? tool.name }
    }
    criteria.none = SKILL_TOOL_HINT_QUESTIONS.tool.none
    questions.tool = choice(SKILL_TOOL_HINT_QUESTIONS.tool.instructions, criteria)
  }

  const state: SkillToolHintRequest['state'] = { message, assistant: input.agentName }
  if (gaps.length > 0) {
    const criteria: Record<string, unknown> = {}
    for (const gap of gaps) {
      criteria[gap.id] = { what: `${gap.label}: ${clip(gap.what, SKILL_TOOL_HINT_LIMITS.maxDescriptionChars) ?? ''}`.trim() }
    }
    criteria.none = SKILL_TOOL_HINT_QUESTIONS.gap.none
    questions.gap = choice(SKILL_TOOL_HINT_QUESTIONS.gap.instructions, criteria)
    questions.gap_needed = noul(SKILL_TOOL_HINT_QUESTIONS.gapNeeded.instructions, SKILL_TOOL_HINT_QUESTIONS.gapNeeded.criteria)
    state.missing_capabilities = gaps.map((gap) => ({ id: gap.id, what: `${gap.label}: ${gap.what}` }))
  }

  return {
    state,
    questions,
    skills,
    tools,
    gaps,
    truncated: {
      skills: input.skills.length > skills.length,
      tools: input.tools.length > tools.length,
      gaps: input.gaps.length > gaps.length
    }
  }
}

export interface SkillToolHintDecision {
  needsAction: number | null
  skill: { candidate: SkillHintCandidate; probability: number } | null
  tool: { candidate: ToolHintCandidate; probability: number } | null
  gap: { candidate: GapCandidate; probability: number; gapNeeded: number } | null
  /** One line for the Execution Viewer: what Jev said and what code did with it. */
  summary: string
}

type SkillToolHintAnswers = {
  needs_action?: JevNoulAnswer
  skill?: JevChoiceAnswer
  tool?: JevChoiceAnswer
  gap?: JevChoiceAnswer
  gap_needed?: JevNoulAnswer
}

function topProbability(answer: JevChoiceAnswer): number {
  const value = answer.probabilities?.[answer.choice]
  return typeof value === 'number' && Number.isFinite(value) ? value : answer.confidence
}

/** Applies the floors. Pure, so a mutation of any threshold above is caught by its test. */
export function decideSkillToolHints(
  answers: SkillToolHintAnswers,
  request: SkillToolHintRequest
): SkillToolHintDecision {
  const needsAction = typeof answers.needs_action?.noul === 'number' ? answers.needs_action.noul : null
  const acts = needsAction !== null && needsAction >= SKILL_TOOL_HINT_THRESHOLDS.needsActionFloor
  const parts: string[] = [`acts ${needsAction === null ? '?' : needsAction.toFixed(2)}`]

  let skill: SkillToolHintDecision['skill'] = null
  if (answers.skill) {
    const probability = topProbability(answers.skill)
    const candidate = request.skills.find((entry) => entry.invocation === answers.skill!.choice) ?? null
    parts.push(`skill ${answers.skill.choice} ${probability.toFixed(2)}`)
    if (acts && candidate && probability >= SKILL_TOOL_HINT_THRESHOLDS.skillFloor) {
      skill = { candidate, probability }
    }
  }

  let tool: SkillToolHintDecision['tool'] = null
  if (answers.tool) {
    const probability = topProbability(answers.tool)
    const candidate = request.tools.find((entry) => entry.ref === answers.tool!.choice) ?? null
    parts.push(`tool ${answers.tool.choice} ${probability.toFixed(2)}`)
    if (acts && candidate && probability >= SKILL_TOOL_HINT_THRESHOLDS.toolFloor) {
      tool = { candidate, probability }
    }
  }

  let gap: SkillToolHintDecision['gap'] = null
  if (answers.gap) {
    const probability = topProbability(answers.gap)
    const gapNeeded = typeof answers.gap_needed?.noul === 'number' ? answers.gap_needed.noul : 0
    const candidate = request.gaps.find((entry) => entry.id === answers.gap!.choice) ?? null
    parts.push(`gap ${answers.gap.choice} ${probability.toFixed(2)} (needed ${gapNeeded.toFixed(2)})`)
    if (
      candidate &&
      probability >= SKILL_TOOL_HINT_THRESHOLDS.gapFloor &&
      gapNeeded >= SKILL_TOOL_HINT_THRESHOLDS.gapNeededFloor
    ) {
      gap = { candidate, probability, gapNeeded }
    }
  }

  const decided = [
    skill ? `hint skill ${skill.candidate.invocation}` : null,
    tool ? `hint tool ${tool.candidate.ref}` : null,
    gap ? `chip ${gap.candidate.label}` : null
  ].filter(Boolean)
  if (request.truncated.tools) parts.push('tools truncated')
  if (request.truncated.gaps) parts.push('gaps truncated')
  const summary = `${parts.join('; ')} → ${decided.length > 0 ? decided.join(', ') : 'no hint'}`

  return { needsAction, skill, tool, gap, summary }
}

export const JEV_JUICE_HINTS_HEADING =
  'jev_juice_hints (advisory guesses from a fast judgment model; ignore any that do not fit):'

/** The DCM tail lines. Empty when nothing cleared a floor, so a quiet turn costs no bytes. */
export function buildJevJuiceHintDcmLines(decision: SkillToolHintDecision): string[] {
  const lines: string[] = []
  if (decision.skill) {
    const { invocation, skillId } = decision.skill.candidate
    lines.push(
      `- Likely skill: ${invocation}${skillId ? ` (skillId=${skillId})` : ''} — if it fits, call native_skill with that skillId and action="invoke" before answering.`
    )
  }
  if (decision.tool) {
    const { ref, hint, enabled } = decision.tool.candidate
    const fields = hint ? ` — fields: ${hint}` : ''
    const how = enabled ? ' (already in your tool list)' : ' (call it through tool_use with these fields, or search first)'
    lines.push(`- Likely tool: ${ref}${fields}${how}`)
  }
  if (decision.gap) {
    lines.push(
      `- Off for this agent: ${decision.gap.candidate.label}. If the request needs it, say so plainly instead of working around it; the user has been shown a note.`
    )
  }
  if (lines.length === 0) return []
  return [JEV_JUICE_HINTS_HEADING, ...lines]
}

/** The chip on the assistant message. Only for a confident gap; it names the gap and never widens access. */
export function buildJevJuiceGap(
  decision: SkillToolHintDecision,
  agent: { id: string; name: string },
  at = new Date()
): JevJuiceGap | null {
  if (!decision.gap) return null
  return {
    id: decision.gap.candidate.id,
    kind: decision.gap.candidate.kind,
    label: decision.gap.candidate.label,
    agentId: agent.id,
    agentName: agent.name,
    probability: decision.gap.probability,
    at: at.toISOString()
  }
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export function skillCandidatesFromCapabilities(capabilities: AgentSlashCapability[]): SkillHintCandidate[] {
  return capabilities
    .filter((capability) => capability.type === 'skill')
    .map((capability) => ({
      invocation: capability.invocation,
      skillId: capability.skillId ?? null,
      description: capability.description ?? capability.displayName ?? null
    }))
}

export function toolCandidatesFromDiscoverable(discoverable: DynamicMcpDiscoverableRef[]): ToolHintCandidate[] {
  return discoverable.map((entry) => ({
    ref: entry.ref,
    name: entry.name,
    family: entry.family,
    description: entry.description ?? (entry.family === 'fabric' || entry.family === 'artifact' ? entry.hint : null),
    hint: entry.hint,
    enabled: entry.enabled
  }))
}

/**
 * The native capabilities an agent can have turned off. Labels are the Agent Settings
 * words; `what` is what Jev reads. Order is the catalog order (native first).
 */
export const NATIVE_CAPABILITY_GAPS = Object.freeze([
  { id: 'native:web_search', setting: 'webSearchEnabled', label: 'Web Search', what: 'search the live web and read current pages, news, prices, docs' },
  { id: 'native:bash', setting: 'bashEnabled', label: 'Bash (run commands)', what: 'run shell commands, scripts, builds, tests, git, and file operations on the project' },
  { id: 'native:agent_browser', setting: 'agentBrowserEnabled', label: 'Agent Browser', what: 'open and drive websites in a browser: click, fill forms, take screenshots' },
  { id: 'native:dynamic_tool_search', setting: 'dynamicMcpEnabled', label: 'Dynamic Tool Search (MCP tools)', what: 'find and call the connected MCP tool servers' },
  { id: 'native:cli_tools', setting: 'cliToolsEnabled', label: 'CLI Tools', what: 'run the user\'s saved command-line tools' },
  { id: 'native:artifact_tools', setting: 'artifactRuntimeEnabled', label: 'Artifact Tools', what: 'run the user\'s published artifacts as tools' },
  { id: 'native:batshit_tools', setting: 'batshitToolsEnabled', label: 'Batshit Tools (Fabric controls)', what: 'manage Batshit itself: artifacts, skills, CLI tools, voice engines, ComfyUI, model catalog' },
  { id: 'native:fetch_zip', setting: 'fetchZipEnabled', label: 'Fetch Zip', what: 'read the full content of a zipped earlier tool result or message' }
] as const)

export interface CapabilityGapCatalogInput {
  userId: string
  agent: Record<string, any>
  /** Skill ids and invocations the agent already has (from `skills_commands`). */
  enabledSkillInvocations: Set<string>
  /** The agent's resolved MCP gateway ids; `null` when Dynamic MCP is off for it. */
  resolvedGatewayIds: string[] | null
  /** CLI tool ids already selected for the agent. */
  selectedCliToolIds: Set<string>
}

/**
 * Everything on this instance the agent does NOT currently have, as short judgeable
 * entries. Redis reads only (never gateway discovery): native toggles from the agent
 * record, skills and CLI tools from their registries, MCP sources from the gateway
 * registry with its cached tool names. A registry read failure logs and omits that
 * family; the judgment still runs over the rest, and the omission is visible in the
 * returned `partial` list.
 */
export async function buildCapabilityGapCatalog(
  input: CapabilityGapCatalogInput
): Promise<{ gaps: GapCandidate[]; partial: string[] }> {
  const gaps: GapCandidate[] = []
  const partial: string[] = []

  const native = resolveNativeToolSettings(input.agent?.provider_specific_settings ?? input.agent?.providerSpecificSettings ?? null)
  for (const entry of NATIVE_CAPABILITY_GAPS) {
    if ((native as unknown as Record<string, unknown>)[entry.setting] === false) {
      gaps.push({ id: entry.id, kind: 'native', label: entry.label, what: entry.what })
    }
  }

  try {
    const all = await listAllSlashCapabilities(input.userId)
    for (const capability of all) {
      if (capability.type !== 'skill') continue
      if (input.enabledSkillInvocations.has(capability.invocation)) continue
      gaps.push({
        id: `skill:${capability.id}`,
        kind: 'skill',
        label: `the ${capability.invocation} skill`,
        what: capability.description ?? capability.displayName
      })
    }
  } catch (error) {
    console.warn('[Jev Juice] gap catalog: skills unavailable', error)
    partial.push('skills')
  }

  try {
    const cliTools = await listCliTools(input.userId)
    for (const record of cliTools) {
      if (record.status !== 'active') continue
      if (input.selectedCliToolIds.has(record.toolId)) continue
      const title = typeof (record as any).title === 'string' ? (record as any).title.trim() : ''
      const description = typeof (record as any).description === 'string' ? (record as any).description.trim() : ''
      gaps.push({
        id: `cli:${record.toolId}`,
        kind: 'cli',
        label: `the ${title || record.toolId} CLI tool`,
        what: description || title || record.toolId
      })
    }
  } catch (error) {
    console.warn('[Jev Juice] gap catalog: CLI tools unavailable', error)
    partial.push('cli')
  }

  if (input.resolvedGatewayIds !== null) {
    try {
      const inScope = new Set(input.resolvedGatewayIds)
      const gateways = await mcpGatewayService.list(input.userId)
      for (const gateway of gateways) {
        if (inScope.has(gateway.id)) continue
        const toolNames = Array.isArray(gateway.discoveredTools)
          ? gateway.discoveredTools.slice(0, SKILL_TOOL_HINT_LIMITS.maxGatewayToolNames)
          : []
        gaps.push({
          id: `gateway:${gateway.id}`,
          kind: 'gateway',
          label: `the "${gateway.name}" MCP source`,
          what: toolNames.length > 0 ? `tools such as ${toolNames.join(', ')}` : `an MCP tool server (${gateway.type})`
        })
      }
    } catch (error) {
      console.warn('[Jev Juice] gap catalog: MCP sources unavailable', error)
      partial.push('gateways')
    }
  }

  return { gaps: gaps.slice(0, SKILL_TOOL_HINT_LIMITS.maxGapCandidates), partial }
}

// ---------------------------------------------------------------------------
// Orchestration (called from the route's hint provider)
// ---------------------------------------------------------------------------

export interface ComputeSkillToolHintsInput {
  userId: string
  agent: Record<string, any>
  message: string
  skills: AgentSlashCapability[]
  discoverable: DynamicMcpDiscoverableRef[]
  resolvedGatewayIds: string[] | null
  /** Test seam. */
  client?: TypesafeClient
  now?: () => Date
}

export interface SkillToolHintsOutcome {
  lines: string[]
  /** `null` when there was nothing to ask (no candidates), so no call was made. */
  record: TypesafeCallRecord | null
  note: JevJuiceNote | null
  gap: JevJuiceGap | null
  decision: SkillToolHintDecision | null
}

/** One send's worth of hints. Never throws; a miss comes back as `record` + `note` with no lines. */
export async function computeSkillToolHints(input: ComputeSkillToolHintsInput): Promise<SkillToolHintsOutcome> {
  const empty: SkillToolHintsOutcome = { lines: [], record: null, note: null, gap: null, decision: null }
  const agentId = String(input.agent?.id ?? '')
  const agentName = String(input.agent?.displayName ?? input.agent?.name ?? agentId ?? 'this agent')

  const skills = skillCandidatesFromCapabilities(input.skills)
  const tools = toolCandidatesFromDiscoverable(input.discoverable)
  const catalog = await buildCapabilityGapCatalog({
    userId: input.userId,
    agent: input.agent,
    enabledSkillInvocations: new Set(input.skills.map((capability) => capability.invocation)),
    resolvedGatewayIds: input.resolvedGatewayIds,
    selectedCliToolIds: new Set(
      input.discoverable.filter((entry) => entry.family === 'cli').map((entry) => entry.name)
    )
  })

  const request = buildSkillToolHintRequest({ message: input.message, agentName, skills, tools, gaps: catalog.gaps })
  if (!request) return empty

  const result = await runTypesafeJudgment({
    userId: input.userId,
    featureId: SKILL_TOOL_HINTS_FEATURE_ID,
    featureEnabled: true,
    state: request.state,
    questions: request.questions,
    // The send waits on this call, so the user's In-Chat Wait Limit is the budget (P8, LS-059).
    lane: 'in_chat',
    client: input.client
  })

  const record = result.record
  if (catalog.partial.length > 0) {
    record.detail = `${record.detail ? `${record.detail}; ` : ''}gap catalog partial: ${catalog.partial.join(', ')}`
  }

  if (!result.response) {
    return { lines: [], record, note: buildJevJuiceNote(record), gap: null, decision: null }
  }

  const decision = decideSkillToolHints(result.response.answers as SkillToolHintAnswers, request)
  record.decision = decision.summary
  return {
    lines: buildJevJuiceHintDcmLines(decision),
    record,
    note: null,
    gap: buildJevJuiceGap(decision, { id: agentId, name: agentName }, (input.now ?? (() => new Date()))()),
    decision
  }
}
