import { afterEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => {
  const mock = {
    get: vi.fn(),
    getSession: vi.fn(async () => null),
    getSessionForCompile: vi.fn(async () => null),
    getUserSettings: vi.fn(),
    getProjects: vi.fn(),
    sMembers: vi.fn(),
    getZips: vi.fn(),
    lRange: vi.fn(async (key: string, start: number, end: number): Promise<string[]> => {
      if (!key.startsWith('messages:') || start !== 0 || end !== -1) {
        throw new Error(`Unexpected compile list read: ${key} ${start} ${end}`)
      }
      const value = await mock.get(key)
      if (value !== null) throw new Error('This fixture supports only known-absent message lists.')
      return []
    }),
    // These compile fixtures contain no persisted skill lifecycle. Read the same
    // store seam and return RedisJSON's missing-key null, never fabricated state.
    json: {
      getRaw: vi.fn(async (key: string, path: string): Promise<null> => {
        if (path !== '$' || !key.startsWith('skill_sessions:')) {
          throw new Error(`Unexpected raw compile read: ${key} ${path}`)
        }
        const value = await mock.get(key)
        if (value !== null) throw new Error('This fixture supports only known-absent skill lifecycle records.')
        return null
      })
    },
    // BL-230: stored prompts are read as raw strings through `execute`, not the facade `get`.
    execute: vi.fn(async (operation: (client: any) => Promise<unknown>) =>
      operation({ get: (key: string) => mock.get(key) })
    )
  }
  return mock
})

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

vi.mock('$env/dynamic/public', () => ({
  env: {}
}))

vi.mock('$lib/services/apiClient', () => ({
  apiClient: {},
  BATSHIT_SERVER_URL: 'http://localhost:5600',
  BATSHIT_SERVER_API_URL: 'http://localhost:5600/api/v1'
}))

vi.mock('./sessionApiClient', () => ({
  sessionApiClient: {
    configureApi: vi.fn()
  }
}))

vi.mock('./messageApiClient', () => ({
  messageApiClient: {
    configureApi: vi.fn()
  }
}))

vi.mock('./agentStore', () => ({
  agentStore: {
    configureApi: vi.fn()
  }
}))

vi.mock('./slashCommandStore', () => ({
  slashCommandStore: {
    configureApi: vi.fn()
  }
}))

vi.mock('./userStore', () => ({
  userStore: {
    configureApi: vi.fn()
  }
}))

import { DatabaseService } from './databaseRedis.server'
import {
  WORKERS_FEATURE_ENABLED,
  WORKERS_MAX_CONCURRENT
} from '$lib/utils/delegationCapabilities'

async function dynamicInfoText(service: DatabaseService, options: Record<string, unknown>): Promise<string> {
  const result = await (service as any).buildDynamicInfoBlock({
    toolIndex: emptyToolIndex(), skillsCommandsDcm: { lines: [], capabilities: [] }, ...options
  })
  expect(result).toMatchObject({
    text: expect.any(String),
    addressSourcePieces: expect.any(Array)
  })
  return result.text
}

function emptyToolIndex() {
  return { text: '', discoverable: [], resolvedGatewayIds: null, setupBlocks: [], sources: [],
    hintBudget: { limit: 3000, budgetedTokens: 0, featureTokens: 0 } }
}

function mockEmptySetupReads(service: DatabaseService) {
  ;(service as any).buildSkillsCommandsDcm = vi.fn().mockResolvedValue({ lines: [], capabilities: [] })
  ;(service as any).buildDynamicMcpDcm = vi.fn().mockResolvedValue(emptyToolIndex())
  // Browser's strict operational settings owner is independent of the project-path
  // and fetch-boundary contracts here, just like the other scoped Setup reads.
  ;(service as any).buildNativeAgentBrowserDcmLines = vi.fn().mockResolvedValue(null)
}

describe('DatabaseService prompt and DCM contract helpers', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('maps the latest user message metadata into the previous DCM snapshot', () => {
    const service = new DatabaseService()

    const snapshot = (service as any).getPreviousDynamicSnapshot([
      {
        role: 'user',
        content: 'older',
        metadata: {
          projectPath: '/Users/example/old',
          fileReferences: [{ path: 'old.ts' }],
          subagentSnapshot: ['old-subagent']
        }
      },
      {
        role: 'assistant',
        content: 'reply',
        metadata: {
          projectPath: '/Users/example/assistant-ignored'
        }
      },
      {
        role: 'user',
        content: 'latest',
        metadata: {
          projectPath: '/Users/example/batshit',
          projectRules: { allowedRoots: ['/Users/example/batshit'] },
          fileReferences: [{ path: 'docs/user-docs/admin/backup-and-restore.md' }],
          subagentSnapshot: ['seed_api_subagent']
        }
      }
    ])

    // SA-139 R4: `subagentSnapshot` fed only the CLI DCM's subagent roster, which left with the
    // CLI Primary; a stored one is ignored.
    expect(snapshot).toEqual({
      projectPath: '/Users/example/batshit',
      projectRules: { allowedRoots: ['/Users/example/batshit'] },
      fileReferences: [{ path: 'docs/user-docs/admin/backup-and-restore.md' }]
    })
  })

  it('tags the current user message before DCM content is appended (SA-128)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-15T16:30:00.000Z'))

    const service = new DatabaseService()
    const formatted = (service as any).formatCurrentUserMessage('Run diagnostics please', null, false)
    expect(formatted).toMatch(/^<user time="[^"]+">\nRun diagnostics please\n<\/user>$/)

    // Batshit's own current message (a woken turn, a group follow-up) is a note, never the user.
    const note = (service as any).formatCurrentUserMessage('[Schedule — not from the user] Check in', null, false, 'batshit')
    expect(note).toMatch(/^<note time="[^"]+">\n\[Schedule — not from the user\] Check in\n<\/note>$/)
  })

  it('exposes the resolved agent default project path from prompt compilation', async () => {
    redisMock.sMembers.mockResolvedValue([])
    redisMock.get.mockResolvedValue(null)
    redisMock.getZips.mockResolvedValue(new Map())

    const service = new DatabaseService()
    ;(service as any).loadSystemPrompts = vi.fn().mockResolvedValue({
      primarySystemPrompt: '',
      globalCustomPrompt: '',
      globalZipSettings: undefined,
      defaultWorkspacePath: '/Users/example/global-default',
      agentDefaultProjectPath: '/Users/example/agent-default',
      agentDefaultProjectRules: undefined
    })
    ;(service as any).compileChatHistory = vi.fn().mockResolvedValue({
      formattedMessages: [],
      currentDay: null,
      chatHistory: '',
      addressSources: [],
      // The real history pass always reports what it compressed and exposed (SA-120 P5, SA-129).
      compressedZips: [],
      exposedZips: []
    })
    ;(service as any).buildDynamicInfoBlock = vi.fn().mockResolvedValue({ text: '', addressSourcePieces: [] })
    mockEmptySetupReads(service)

    const result = await service.buildFormattedChatInput(
      'session-1',
      [],
      {
        id: 'agent-api',
        primary_agent_type: 'api',
        name: 'Cody',
        // The project path is under test, not the board: the factory Whiteboard (SA-126) would read
        // the board through Redis JSON, outside this fixture's lifecycle-only read.
        api_reasoning_retention: 'neither'
      },
      'hello',
      [],
      'josh',
      {
        runtimeFlavor: 'claude'
      }
    )

    expect(result.resolvedProjectPath).toBe('/Users/example/agent-default')
    expect(result.structuredInput.metadata.resolvedProjectPath).toBe('/Users/example/agent-default')
    expect(redisMock.json.getRaw).toHaveBeenCalledExactlyOnceWith('skill_sessions:session-1', '$')
  })

  it('summarizes auto-zip content and tool settings for the DCM block', () => {
    const service = new DatabaseService()
    const summary = (service as any).buildAutoZipSummary({
      agent: {
        custom_tool_settings: [
          {
            tool_name: 'sample_echo',
            auto_zip: true
          }
        ]
      },
      globalZipSettings: {
        auto_zip_image: true,
        auto_zip_subagent: true,
        custom_tool_settings: [
          {
            tool_name: 'global_tool',
            auto_zip: true
          }
        ]
      }
    })

    expect(summary.autoZipContent).toEqual(expect.arrayContaining(['image']))
    expect(summary.autoZipContent).not.toContain('code')
    expect(summary.autoZipTools).toEqual(
      expect.arrayContaining(['subagent', 'sample_echo', 'global_tool'])
    )
  })

  it('lists the factory Auto rows for an agent record that stores no zip row (SA-126 C6, 2026-10-19)', () => {
    const service = new DatabaseService()
    const summarize = (agent: Record<string, unknown>, globalZipSettings: Record<string, unknown> = {}) =>
      (service as any).buildAutoZipSummary({ agent, globalZipSettings }).autoZipTools
    expect(summarize({})).toEqual(['write_file', 'edit_file', 'execute_command', 'list_files', 'all_other_tools'])
    // A stored row still wins, agent first, then global; Off is never listed as Auto.
    expect(summarize({ auto_zip_all_other_tools: false })).not.toContain('all_other_tools')
    expect(summarize({}, { auto_zip_all_other_tools: false })).not.toContain('all_other_tools')
    expect(summarize({ zip_disabled_all_other_tools: true })).not.toContain('all_other_tools')
    expect(summarize({ auto_zip_read_file: true, auto_zip_edit_file: false })).toEqual(
      ['read_file', 'write_file', 'execute_command', 'list_files', 'all_other_tools']
    )
  })

  // SA-139 R4: the Claude CLI DCM's subagent roster (its MCP tool names and capability lines) left
  // with the CLI Primary; the DCM carries no roster, and API stable facts belong to Agent Setup.
  it('keeps no subagent roster in the DCM: API stable facts belong to Agent Setup (BL-2260)', async () => {
    const service = new DatabaseService()

    const options = {
      agentId: 'sample_api_primary',
      agentRecord: { id: 'sample_api_primary' },
      subagentDescriptions: {
        researcher: 'Digs through docs',
        n8n_helper: 'Runs the intake workflow'
      },
      subagentCapabilityFragments: {
        researcher:
          'Subagent; model: anthropic/claude-sonnet-5; tools: Bash, Web Search, MCP (Docker Catalog); skills: /research; thread: resumable',
        n8n_helper: 'n8n Workflow Subagent; model: not set here; tools: defined in n8n; skills: none; thread: none'
      },
      assignedSubagents: [
        { id: 'researcher', slug: 'researcher', name: 'Researcher', displayName: 'Researcher' },
        { id: 'n8n_helper', slug: 'n8n_helper', name: 'n8n Helper', displayName: 'n8n Helper' }
      ]
    }
    // S28 in databaseRedis.compileContract.test.ts covers API Setup plus current
    // thread facts through the real compile and captured registrations.
    const apiBlock = await dynamicInfoText(service, options)
    expect(apiBlock).not.toContain('subagents:')
    expect(apiBlock).not.toContain('Researcher (researcher)')
    expect(apiBlock).not.toContain('CLI subagent delegation')
  })

  it('SA-111 P4: Agent Setup carries a workers line that follows the per-agent setting', () => {
    // The `workers:` line and the `spawn_workers` tool ship together — an agent told it has
    // workers must actually have the tool, and an agent with the setting off must be told
    // so rather than left to guess. That pairing is the F1 failure this story exists to fix.
    const service = new DatabaseService()
    expect(WORKERS_FEATURE_ENABLED).toBe(true)

    const enabled = (service as any).buildWorkersSetupLine({ id: 'sample_api_primary', workers_enabled: true })
    expect(enabled).toContain(
      `workers: enabled (max ${WORKERS_MAX_CONCURRENT} parallel)`
    )
    // Delegation limits (decision 6): six at a time, and no per-turn total to state any more.
    expect(WORKERS_MAX_CONCURRENT).toBe(6)
    expect(enabled).not.toContain('per turn')

    const disabled = (service as any).buildWorkersSetupLine({ id: 'sample_api_primary', workers_enabled: false })
    expect(disabled).toContain('workers: disabled')

    // Default ON for a primary agent that never stored the field (DL-111-11).
    const defaulted = (service as any).buildWorkersSetupLine({ id: 'sample_api_primary' })
    expect(defaulted).toContain('workers: enabled')
    // The API lane has no composed MCP name to print (SA-139 R4: the CLI lane that did is gone).
    expect(enabled).toBe(`workers: enabled (max ${WORKERS_MAX_CONCURRENT} parallel)`)
    expect(enabled).not.toContain('tool: mcp__')
  })

  it('adds concise speech-to-text guidance when the current user message was transcribed', async () => {
    const service = new DatabaseService()

    const block = await dynamicInfoText(service, {
      agentId: 'voice-agent',
      voiceState: {
        stt: true,
        tts: false,
        voiceMode: 'text'
      }
    })

    expect(block).toContain('Voice runtime context:')
    expect(block).toContain('the user spoke this message and speech-to-text (STT) transcribed it')
    expect(block).toContain('ignore [BLANK AUDIO]')
    expect(block).toContain('"Mike check" may mean "mic check"')
    expect(block).not.toContain('your reply will be spoken aloud')
  })

  it('does not add voice runtime context for saved provider config alone', async () => {
    const service = new DatabaseService()

    const block = await dynamicInfoText(service, {
      agentId: 'voice-agent',
      voiceState: {
        stt: false,
        tts: false,
        voiceMode: 'text',
        provider: 'google',
        guidance: ['Engine guidance should stay hidden unless this turn speaks.']
      }
    })

    expect(block).not.toContain('Voice runtime context:')
    expect(block).not.toContain('Provider: google')
    expect(block).not.toContain('Engine guidance should stay hidden')
  })

  it('keeps provider and engine guidance out of STT-only turns', async () => {
    const service = new DatabaseService()

    const block = await dynamicInfoText(service, {
      agentId: 'voice-agent',
      voiceState: {
        stt: true,
        tts: false,
        voiceMode: 'text',
        provider: 'google',
        guidance: ['Spoken reply guidance should stay hidden.']
      }
    })

    expect(block).toContain('Voice runtime context:')
    expect(block).toContain('the user spoke this message and speech-to-text (STT) transcribed it')
    expect(block).not.toContain('Provider: google')
    expect(block).not.toContain('Spoken reply guidance should stay hidden')
    expect(block).not.toContain('your reply will be spoken aloud')
  })

  it('adds spoken-reply brevity guidance when Voice Mode is active', async () => {
    const service = new DatabaseService()

    const block = await dynamicInfoText(service, {
      agentId: 'voice-agent',
      voiceState: {
        stt: true,
        tts: true,
        voiceMode: 'voice',
        provider: 'fish'
      }
    })

    expect(block).toContain('Voice runtime context:')
    expect(block).toContain('the user spoke this message and speech-to-text (STT) transcribed it')
    expect(block).toContain('your reply will be spoken aloud')
    expect(block).toContain('1-3 short sentences')
    expect(block).toContain('avoid bullets/long lists')
    expect(block).toContain('Provider: fish')
  })

  it('adds TTS engine prompt guidance only for spoken replies', async () => {
    const service = new DatabaseService()

    const block = await dynamicInfoText(service, {
      agentId: 'voice-agent',
      voiceState: {
        stt: false,
        tts: true,
        voiceMode: 'voice',
        provider: 'openai',
        guidance: [
          'TTS engine prompt (openai): follow these engine-specific speaking instructions when writing text that will be spoken by this provider.',
          'Use [whispers] sparingly and keep expressive cues short.'
        ]
      }
    })

    expect(block).toContain('Voice runtime context:')
    expect(block).toContain('Provider: openai')
    expect(block).toContain('TTS engine prompt (openai)')
    expect(block).toContain('Use [whispers] sparingly')
  })

  it('adds compact runtime network guidance to Setup without baseline runtime URL aliases', () => {
    const service = new DatabaseService()

    const agent = { id: 'api-agent', primary_agent_type: 'api' }
    const block = [(service as any).buildNativeBashDcmLine(agent), (service as any).buildRuntimeNetworkDcmLine(agent)].join('\n')

    expect(block).toContain('native_bash: enabled')
    expect(block).toContain('runtime_network: backend=')
    if (block.includes('runtime_network: backend=docker_sandbox')) {
      expect(block).toContain('host.docker.internal')
    } else {
      expect(block).toContain('runtime_network: backend=apple_container')
      expect(block).toContain('internal deny-network policy')
      expect(block).not.toContain('host.docker.internal')
    }
    expect(block).not.toContain('runtime_url_aliases')
    expect(block).not.toContain('comfyui_api_')
    expect(block).not.toContain('batshit_server_upload_single')
  })

  it('states the enforced Plan-mode read-only boundary in Setup', () => {
    const service = new DatabaseService()

    const block = (service as any).buildNativeBashDcmLine({
        id: 'api-plan-agent',
        primary_agent_type: 'api',
        provider_specific_settings: {
          nativeTools: {
            bashEnabled: true,
            bashAccessMode: 'plan'
          }
        }
    })

    expect(block).toContain('native_bash: enabled | mode=plan')
    expect(block).toContain('proven read/search + .md edits only')
    expect(block).toContain('hidden side effects and executor/writer pipeline stages blocked')
  })

  it('does not use global fetch when server prompt compilation has no event.fetch', async () => {
    redisMock.sMembers.mockResolvedValue([])
    redisMock.get.mockResolvedValue(null)
    redisMock.getZips.mockResolvedValue(new Map())

    const globalFetch = vi.fn(async () => {
      throw new Error('global fetch should not be used during server prompt compilation')
    })
    vi.stubGlobal('fetch', globalFetch)

    const service = new DatabaseService()
    ;(service as any).loadSystemPrompts = vi.fn().mockResolvedValue({
      primarySystemPrompt: '',
      globalCustomPrompt: '',
      globalZipSettings: undefined,
      defaultWorkspacePath: undefined,
      agentDefaultProjectPath: undefined,
      agentDefaultProjectRules: undefined
    })
    ;(service as any).compileChatHistory = vi.fn().mockResolvedValue({
      formattedMessages: [],
      currentDay: null,
      chatHistory: '',
      addressSources: [],
      // The real history pass always reports what it compressed and exposed (SA-120 P5, SA-129).
      compressedZips: [],
      exposedZips: []
    })
    ;(service as any).buildDynamicInfoBlock = vi.fn().mockResolvedValue({ text: '', addressSourcePieces: [] })
    mockEmptySetupReads(service)

    await service.buildFormattedChatInput(
      'livekit-session',
      [],
      {
        id: 'agent-api',
        primary_agent_type: 'api',
        name: 'Kiriko'
      },
      'LiveKit true speech-to-speech voice session started.',
      [],
      'josh',
      {
        runtimeFlavor: 'vercel',
        voiceState: {
          stt: true,
          tts: true,
          voiceMode: 'speech-to-speech',
          provider: 'livekit'
        }
      }
    )

    expect(globalFetch).not.toHaveBeenCalled()
    expect(redisMock.json.getRaw).toHaveBeenCalledExactlyOnceWith('skill_sessions:livekit-session', '$')
  })
})
