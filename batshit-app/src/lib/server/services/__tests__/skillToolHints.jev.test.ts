// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypesafeConfig } from '$lib/types/typesafe'

/**
 * SA-120 P1 — the skill/tool hint lane: request shape, the floors (each one mutation-
 * sensitive), the DCM lines, the gap chip, the catalog, and the orchestrator against an
 * injected fetch. No network.
 */

const retrieve = vi.hoisted(() => vi.fn<(service: string, userId: string) => Promise<string | null>>())
const dynamicPrivateEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }))
const configState = vi.hoisted(() => ({
  config: { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null } as TypesafeConfig
}))
const registries = vi.hoisted(() => ({
  listAllSlashCapabilities: vi.fn(async () => [] as any[]),
  listCliTools: vi.fn(async () => [] as any[]),
  gatewayList: vi.fn(async () => [] as any[]),
  resolveNativeToolSettings: vi.fn((settings: any) => ({
    webSearchEnabled: settings?.webSearchEnabled ?? true,
    bashEnabled: true,
    agentBrowserEnabled: settings?.agentBrowserEnabled ?? true,
    dynamicMcpEnabled: true,
    cliToolsEnabled: true,
    artifactRuntimeEnabled: true,
    batshitToolsEnabled: true,
    fetchZipEnabled: true
  }))
}))

vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve } }))
vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)
vi.mock('../typesafe/typesafeConfig', () => ({ getTypesafeConfig: vi.fn(async () => configState.config) }))
vi.mock('../slashCommandCapabilities', () => ({ listAllSlashCapabilities: registries.listAllSlashCapabilities }))
vi.mock('../cliToolRegistry', () => ({ listCliTools: registries.listCliTools }))
vi.mock('../mcpGatewayService', () => ({ mcpGatewayService: { list: registries.gatewayList } }))
vi.mock('../nativeTools', () => ({ resolveNativeToolSettings: registries.resolveNativeToolSettings }))

import { createTypesafeClient, type TypesafeFetch } from '../typesafe/typesafeClient'
import {
  JEV_JUICE_HINTS_HEADING,
  SKILL_TOOL_HINT_THRESHOLDS,
  buildCapabilityGapCatalog,
  buildJevJuiceGap,
  buildJevJuiceHintDcmLines,
  buildSkillToolHintRequest,
  computeSkillToolHints,
  decideSkillToolHints,
  type SkillToolHintRequest
} from '../skillToolHints.jev'

const SKILLS = [
  { invocation: '/vroid-dressup', skillId: 'vroid_dressup', description: 'Dress a VRoid Goon with XWear clothing' },
  { invocation: '/voice-engine-installer', skillId: 'voice_engine_installer', description: 'Install and register TTS/STT engines' }
]
const TOOLS = [
  { ref: 'mcp:hf_search', name: 'hf_search', family: 'mcp' as const, description: 'Search Hugging Face models', hint: 'required: query:string', enabled: false },
  { ref: 'fabric:sys.memory.save', name: 'sys.memory.save', family: 'fabric' as const, description: 'Save a memory', hint: 'lane, content', enabled: false }
]
const GAPS = [
  { id: 'native:web_search', kind: 'native' as const, label: 'Web Search', what: 'search the live web' }
]

function request(overrides: Partial<Parameters<typeof buildSkillToolHintRequest>[0]> = {}): SkillToolHintRequest {
  const built = buildSkillToolHintRequest({
    message: 'find me the newest small embedding model on hugging face',
    agentName: 'Faye',
    skills: SKILLS,
    tools: TOOLS,
    gaps: GAPS,
    ...overrides
  })
  if (!built) throw new Error('expected a request')
  return built
}

function answers(overrides: Record<string, any> = {}) {
  return {
    needs_action: { type: 'noul', noul: 0.9 },
    skill: { type: 'choice', choice: 'none', probabilities: { none: 0.8, '/vroid-dressup': 0.1, '/voice-engine-installer': 0.1 }, confidence: 0.7 },
    tool: { type: 'choice', choice: 'mcp:hf_search', probabilities: { 'mcp:hf_search': 0.82, 'fabric:sys.memory.save': 0.08, none: 0.1 }, confidence: 0.75 },
    gap: { type: 'choice', choice: 'none', probabilities: { none: 0.7, 'native:web_search': 0.3 }, confidence: 0.5 },
    gap_needed: { type: 'noul', noul: 0.2 },
    ...overrides
  } as any
}

describe('buildSkillToolHintRequest', () => {
  it('asks everything in one request: the gate, a skill Choice, a tool Choice, and the gap pair', () => {
    const built = request()
    expect(Object.keys(built.questions).sort()).toEqual(['gap', 'gap_needed', 'needs_action', 'skill', 'tool'])
    expect(built.questions.skill.type).toBe('choice')
    expect(Object.keys((built.questions.skill as any).criteria)).toEqual(['/vroid-dressup', '/voice-engine-installer', 'none'])
    expect(Object.keys((built.questions.tool as any).criteria)).toEqual(['mcp:hf_search', 'fabric:sys.memory.save', 'none'])
    // Field hints stay out of the criteria (request size); the winner's hint comes from the candidate.
    expect((built.questions.tool as any).criteria['mcp:hf_search']).toEqual({ what: 'Search Hugging Face models' })
    expect(built.state).toEqual({
      message: 'find me the newest small embedding model on hugging face',
      assistant: 'Faye',
      missing_capabilities: [{ id: 'native:web_search', what: 'Web Search: search the live web' }]
    })
  })

  it('omits a Choice with no candidates and returns null when there is nothing to pick from', () => {
    const noSkills = request({ skills: [] })
    expect(noSkills.questions.skill).toBeUndefined()
    const noGaps = request({ gaps: [] })
    expect(noGaps.questions.gap).toBeUndefined()
    expect(noGaps.questions.gap_needed).toBeUndefined()
    expect(noGaps.state.missing_capabilities).toBeUndefined()
    expect(buildSkillToolHintRequest({ message: 'hi', agentName: 'F', skills: [], tools: [], gaps: [] })).toBeNull()
    expect(buildSkillToolHintRequest({ message: '   ', agentName: 'F', skills: SKILLS, tools: [], gaps: [] })).toBeNull()
  })

  it('caps the Choice lists under the vendor limit and says so', () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      ref: `mcp:tool_${index}`, name: `tool_${index}`, family: 'mcp' as const, description: null, hint: null, enabled: false
    }))
    const built = request({ tools: many })
    expect(Object.keys((built.questions.tool as any).criteria)).toHaveLength(240)
    expect(built.truncated.tools).toBe(true)
  })
})

describe('decideSkillToolHints (the floors)', () => {
  it('writes a tool hint above the floor and no skill hint when Jev picked none', () => {
    const decision = decideSkillToolHints(answers(), request())
    expect(decision.tool?.candidate.ref).toBe('mcp:hf_search')
    expect(decision.skill).toBeNull()
    expect(decision.gap).toBeNull()
    expect(decision.summary).toContain('→ hint tool mcp:hf_search')
  })

  it('withholds every hint when the action gate is under its floor', () => {
    const under = SKILL_TOOL_HINT_THRESHOLDS.needsActionFloor - 0.01
    const decision = decideSkillToolHints(answers({ needs_action: { type: 'noul', noul: under } }), request())
    expect(decision.tool).toBeNull()
    expect(decision.summary).toContain('no hint')
    const at = decideSkillToolHints(answers({ needs_action: { type: 'noul', noul: SKILL_TOOL_HINT_THRESHOLDS.needsActionFloor } }), request())
    expect(at.tool).not.toBeNull()
  })

  it('applies the tool floor exactly', () => {
    const floor = SKILL_TOOL_HINT_THRESHOLDS.toolFloor
    const just = answers({ tool: { type: 'choice', choice: 'mcp:hf_search', probabilities: { 'mcp:hf_search': floor, none: 1 - floor }, confidence: 0.5 } })
    expect(decideSkillToolHints(just, request()).tool).not.toBeNull()
    const under = answers({ tool: { type: 'choice', choice: 'mcp:hf_search', probabilities: { 'mcp:hf_search': floor - 0.01, none: 1 - floor + 0.01 }, confidence: 0.5 } })
    expect(decideSkillToolHints(under, request()).tool).toBeNull()
  })

  it('applies the skill floor and ignores a choice that is not a candidate', () => {
    const floor = SKILL_TOOL_HINT_THRESHOLDS.skillFloor
    const hit = answers({ skill: { type: 'choice', choice: '/vroid-dressup', probabilities: { '/vroid-dressup': floor, none: 1 - floor }, confidence: 0.6 } })
    expect(decideSkillToolHints(hit, request()).skill?.candidate.skillId).toBe('vroid_dressup')
    const unknown = answers({ skill: { type: 'choice', choice: '/not-a-skill', probabilities: { '/not-a-skill': 0.99 }, confidence: 0.9 } })
    expect(decideSkillToolHints(unknown, request()).skill).toBeNull()
  })

  it('needs BOTH the gap floor and the gap-needed floor for a gap, and does not gate gaps on the action Noul', () => {
    const { gapFloor, gapNeededFloor } = SKILL_TOOL_HINT_THRESHOLDS
    const both = answers({
      needs_action: { type: 'noul', noul: 0.1 },
      gap: { type: 'choice', choice: 'native:web_search', probabilities: { 'native:web_search': gapFloor, none: 1 - gapFloor }, confidence: 0.6 },
      gap_needed: { type: 'noul', noul: gapNeededFloor }
    })
    expect(decideSkillToolHints(both, request()).gap?.candidate.label).toBe('Web Search')
    const onlyChoice = answers({
      gap: { type: 'choice', choice: 'native:web_search', probabilities: { 'native:web_search': 0.99, none: 0.01 }, confidence: 0.9 },
      gap_needed: { type: 'noul', noul: gapNeededFloor - 0.01 }
    })
    expect(decideSkillToolHints(onlyChoice, request()).gap).toBeNull()
    const onlyNoul = answers({
      gap: { type: 'choice', choice: 'native:web_search', probabilities: { 'native:web_search': gapFloor - 0.01, none: 1 - gapFloor + 0.01 }, confidence: 0.5 },
      gap_needed: { type: 'noul', noul: 0.99 }
    })
    expect(decideSkillToolHints(onlyNoul, request()).gap).toBeNull()
  })
})

describe('DCM lines and the gap chip', () => {
  it('renders nothing for a quiet turn and the heading plus one line per hit otherwise', () => {
    const quiet = decideSkillToolHints(answers({ tool: { type: 'choice', choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9 } }), request())
    expect(buildJevJuiceHintDcmLines(quiet)).toEqual([])

    const loud = decideSkillToolHints(
      answers({
        skill: { type: 'choice', choice: '/vroid-dressup', probabilities: { '/vroid-dressup': 0.7, none: 0.3 }, confidence: 0.6 },
        gap: { type: 'choice', choice: 'native:web_search', probabilities: { 'native:web_search': 0.8, none: 0.2 }, confidence: 0.7 },
        gap_needed: { type: 'noul', noul: 0.8 }
      }),
      request()
    )
    const lines = buildJevJuiceHintDcmLines(loud)
    expect(lines[0]).toBe(JEV_JUICE_HINTS_HEADING)
    expect(lines[1]).toContain('Likely skill: /vroid-dressup (skillId=vroid_dressup)')
    expect(lines[2]).toContain('Likely tool: mcp:hf_search — fields: required: query:string')
    expect(lines[3]).toContain('Off for this agent: Web Search.')
    expect(lines).toHaveLength(4)

    const gap = buildJevJuiceGap(loud, { id: 'agent_1', name: 'Faye' }, new Date('2026-09-16T12:00:00.000Z'))
    expect(gap).toEqual({
      id: 'native:web_search', kind: 'native', label: 'Web Search', agentId: 'agent_1', agentName: 'Faye', probability: 0.8, at: '2026-09-16T12:00:00.000Z'
    })
    expect(buildJevJuiceGap(quiet, { id: 'agent_1', name: 'Faye' })).toBeNull()
  })
})

describe('buildCapabilityGapCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists OFF native toggles, unassigned skills, unselected CLI tools, and out-of-scope MCP sources', async () => {
    registries.listAllSlashCapabilities.mockResolvedValue([
      { id: 'vroid', type: 'skill', invocation: '/vroid-dressup', displayName: 'VRoid', description: 'Dress a Goon' },
      { id: 'installer', type: 'skill', invocation: '/voice-engine-installer', displayName: 'Installer', description: 'Install engines' },
      { id: 'greet', type: 'prompt', invocation: '/greet', displayName: 'Greet' }
    ])
    registries.listCliTools.mockResolvedValue([
      { toolId: 'ffmpeg', status: 'active', title: 'ffmpeg', description: 'Convert media' },
      { toolId: 'old', status: 'archived', title: 'old' },
      { toolId: 'selected', status: 'active', title: 'Selected' }
    ])
    registries.gatewayList.mockResolvedValue([
      { id: 'gw_hf', name: 'HuggingFace', type: 'http', enabled: true, discoveredTools: ['hf_search'] },
      { id: 'gw_github', name: 'GitHub', type: 'http', enabled: true, discoveredTools: ['create_issue', 'list_prs'] }
    ])
    const { gaps, partial } = await buildCapabilityGapCatalog({
      userId: 'josh',
      agent: { provider_specific_settings: { webSearchEnabled: false, agentBrowserEnabled: false } },
      enabledSkillInvocations: new Set(['/vroid-dressup']),
      resolvedGatewayIds: ['gw_hf'],
      selectedCliToolIds: new Set(['selected'])
    })
    expect(partial).toEqual([])
    expect(gaps.map((gap) => gap.id)).toEqual([
      'native:web_search',
      'native:agent_browser',
      'skill:installer',
      'cli:ffmpeg',
      'gateway:gw_github'
    ])
    expect(gaps.find((gap) => gap.id === 'gateway:gw_github')?.what).toBe('tools such as create_issue, list_prs')
  })

  it('skips MCP sources entirely when Dynamic Tool Search is off for the agent, and reports a failed registry as partial', async () => {
    registries.listAllSlashCapabilities.mockRejectedValue(new Error('redis down'))
    registries.listCliTools.mockResolvedValue([])
    registries.gatewayList.mockResolvedValue([{ id: 'gw', name: 'X', type: 'http', enabled: true }])
    const { gaps, partial } = await buildCapabilityGapCatalog({
      userId: 'josh',
      agent: {},
      enabledSkillInvocations: new Set(),
      resolvedGatewayIds: null,
      selectedCliToolIds: new Set()
    })
    expect(gaps).toEqual([])
    expect(partial).toEqual(['skills'])
    expect(registries.gatewayList).not.toHaveBeenCalled()
  })
})

describe('computeSkillToolHints', () => {
  function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    configState.config = { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }
    retrieve.mockResolvedValue('user-key')
    registries.listAllSlashCapabilities.mockResolvedValue([])
    registries.listCliTools.mockResolvedValue([])
    registries.gatewayList.mockResolvedValue([])
  })

  const skills = [{ id: 'vroid', name: 'vroid', displayName: 'VRoid', type: 'skill' as const, invocation: '/vroid-dressup', isSystem: false, skillId: 'vroid_dressup', description: 'Dress a Goon' }]
  const discoverable = [{ ref: 'mcp:hf_search', family: 'mcp' as const, name: 'hf_search', group: 'HF', description: 'Search models', hint: 'required: query:string', enabled: false }]

  it('makes one call under the compile-lane deadline and returns lines, a record with the decision, and a gap', async () => {
    const fetchImpl = vi.fn<TypesafeFetch>().mockResolvedValue(
      jsonResponse({
        model: 'jev-1.13.0',
        answers: {
          needs_action: { type: 'noul', noul: 0.9 },
          skill: { type: 'choice', choice: 'none', probabilities: { none: 0.9, '/vroid-dressup': 0.1 }, confidence: 0.8 },
          tool: { type: 'choice', choice: 'mcp:hf_search', probabilities: { 'mcp:hf_search': 0.8, none: 0.2 }, confidence: 0.7 },
          gap: { type: 'choice', choice: 'native:web_search', probabilities: { 'native:web_search': 0.75, none: 0.25 }, confidence: 0.6 },
          gap_needed: { type: 'noul', noul: 0.7 }
        },
        usage: { input_tokens: 400, output_tokens: 20 }
      })
    )
    const outcome = await computeSkillToolHints({
      userId: 'josh',
      agent: { id: 'agent_1', displayName: 'Faye', provider_specific_settings: { webSearchEnabled: false } },
      message: 'what is the newest embedding model on hugging face right now',
      skills,
      discoverable,
      resolvedGatewayIds: ['gw_hf'],
      client: createTypesafeClient({ fetch: fetchImpl, dispatcher: null })
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1].body))
    expect(sent.model).toBe('jev-1.13.0')
    expect(Object.keys(sent.questions).sort()).toEqual(['gap', 'gap_needed', 'needs_action', 'skill', 'tool'])
    expect(outcome.lines[0]).toBe(JEV_JUICE_HINTS_HEADING)
    expect(outcome.lines.some((line) => line.includes('mcp:hf_search'))).toBe(true)
    expect(outcome.record).toMatchObject({ feature: 'skill_tool_hints', status: 'ok', usage: { inputTokens: 400, outputTokens: 20 }, questionCount: 5 })
    expect(outcome.record?.decision).toContain('chip Web Search')
    expect(outcome.gap?.label).toBe('Web Search')
    expect(outcome.note).toBeNull()
  })

  it('on a miss returns no lines, an unavailable record, and a note; the send goes on', async () => {
    const fetchImpl: TypesafeFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        ;(init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('x', 'AbortError')), { once: true })
      })
    const outcome = await computeSkillToolHints({
      userId: 'josh',
      agent: { id: 'agent_1', displayName: 'Faye' },
      message: 'do the thing',
      skills,
      discoverable,
      resolvedGatewayIds: null,
      client: createTypesafeClient({ fetch: fetchImpl, dispatcher: null })
    })
    expect(outcome.lines).toEqual([])
    expect(outcome.record).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true })
    expect(outcome.note).toMatchObject({ feature: 'skill_tool_hints', status: 'unavailable', reason: 'deadline' })
    expect(outcome.gap).toBeNull()
  })

  it('SA-120 P8: the call runs under the stored In-Chat Wait Limit, and a change reaches the very next send', async () => {
    const budgets: Array<number | undefined> = []
    const recording = {
      async systemOne(request: { deadlineMs?: number }) {
        budgets.push(request.deadlineMs)
        return { status: 'unavailable', reason: 'deadline', latencyMs: 1, attempts: 1, deadlineHit: true, requestChars: 10 } as never
      }
    }
    const run = () =>
      computeSkillToolHints({
        userId: 'josh',
        agent: { id: 'agent_1', displayName: 'Faye' },
        message: 'do the thing',
        skills,
        discoverable,
        resolvedGatewayIds: null,
        client: recording as never
      })
    await run()
    configState.config = { ...configState.config, inChatWaitMs: 5000 }
    await run()
    expect(budgets).toEqual([750, 5000])
  })

  it('makes no call and no record when the agent has nothing to pick from', async () => {
    const fetchImpl = vi.fn<TypesafeFetch>()
    const outcome = await computeSkillToolHints({
      userId: 'josh',
      agent: { id: 'agent_1', displayName: 'Faye' },
      message: 'hello there',
      skills: [],
      discoverable: [],
      resolvedGatewayIds: null,
      client: createTypesafeClient({ fetch: fetchImpl, dispatcher: null })
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(outcome).toEqual({ lines: [], record: null, note: null, gap: null, decision: null })
  })

  it('DL-120-11: with the master switch OFF the lane makes no call and reports master_off', async () => {
    configState.config = { ...configState.config, enabled: false }
    const fetchImpl = vi.fn<TypesafeFetch>()
    const outcome = await computeSkillToolHints({
      userId: 'josh',
      agent: { id: 'agent_1', displayName: 'Faye' },
      message: 'search for something',
      skills,
      discoverable,
      resolvedGatewayIds: null,
      client: createTypesafeClient({ fetch: fetchImpl, dispatcher: null })
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(outcome.record).toMatchObject({ status: 'unavailable', reason: 'master_off' })
    expect(outcome.note?.reason).toBe('master_off')
  })
})
